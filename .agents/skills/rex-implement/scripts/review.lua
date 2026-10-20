-- Open one Rex window with a pane per one-shot reviewer, wait until every reviewer has ended, and report.
--
--   rex do --fail-fast -s SESSION review.lua --args @/abs/run/PR1-R1-review.json
--
-- The JSON file holds:
--   window     the tab's label, such as "Review PR1 R1"
--   cwd        the worktree every reviewer runs in
--   limit      seconds to wait before giving up, default 3600
--   reviewers  a list of { role, report, command, tee }. command is the argv the pane runs.
--              report is the file that receives the reviewer's final message: the CLI writes
--              it (codex exec -o), or, with tee = true, the pane copies the CLI's stdout into it.
--
-- The commands live in the file, so this watcher's own command line names no reviewer CLI,
-- and a pkill -f aimed at one leaves the watcher running.
--
-- Removes each report file before the panes start, so a report from an earlier attempt never counts.
-- Takes a snapshot of cwd before the panes start and again at the end.
-- Prints one JSON line once the panes start: { window_id, blocks = { role = block_id } }.
-- Prints one JSON line at the end:
--   { window_id, snapshot = { before, after, changed }, reviewers = [ { role, block_id, state, exit_code, msg, report, complete } ] }.
-- state is "exited" (the CLI exited), "closed" (its pane closed first) or "running" (the limit passed first).
-- complete is true when the report exists and has an END-OF-FINDINGS line.
-- changed is true when a reviewer edited the worktree. snapshot.error replaces after when the second snapshot fails.
-- Exit 0: every reviewer ended. 1: the first snapshot failed, the window could not open, or the script failed.
-- 2: the limit passed first. 64: bad arguments.
-- The window stays open after the end. Close it with rex window close once the reports are read.
local shell = "com.superlogical.terminal.shell"
local args = rex.args
local reviewers = args.reviewers
local limit = args.limit or 3600
local results = {}
local order = {}
local pending = 0
local window_id
local before

local function fail(message, code)
  io.stderr:write(message .. "\n")
  rex.stop(code)
end

if type(args.window) ~= "string" or type(args.cwd) ~= "string" or type(reviewers) ~= "table" or #reviewers == 0 then
  fail("--args takes window, cwd and a non-empty reviewers list", 64)
end

for _, r in ipairs(reviewers) do
  if type(r.role) ~= "string" or type(r.report) ~= "string" or type(r.command) ~= "table" or #r.command == 0 then
    fail("each reviewer takes role, report and a non-empty command list", 64)
  end
end

-- Matches the marker loosely: Codex has ended it with a trailing period, and Markdown may wrap it in bullets or bold.
local function complete(path)
  local f = io.open(path, "r")
  if f == nil then
    return false
  end

  local text = f:read("*a")
  f:close()

  for line in text:gmatch("[^\r\n]+") do
    if line:match("^%W*END%-OF%-FINDINGS%W*$") then
      return true
    end
  end

  return false
end

-- The tree hash of the whole worktree, built in a throwaway index so the real one stays untouched.
-- git status lists names only, so it misses a reviewer's edit to a file the executor already changed. The hash changes.
local function snapshot()
  local index = os.tmpname()
  os.remove(index)

  local opts = { cwd = args.cwd, env = { GIT_INDEX_FILE = index } }
  local steps = { { "git", "read-tree", "HEAD" }, { "git", "add", "-A" }, { "git", "write-tree" } }
  local r, err

  for _, argv in ipairs(steps) do
    r, err = rex.exec(argv, opts)
    if r == nil or not r.ok then
      os.remove(index)
      return nil, err or (table.concat(argv, " ") .. ": " .. r.stderr)
    end
  end

  os.remove(index)
  return (r.stdout:gsub("%s+$", ""))
end

local function finish(code)
  local list = {}

  for _, id in ipairs(order) do
    local r = results[id]
    list[#list + 1] = {
      role = r.role,
      block_id = id,
      state = r.state or "running",
      exit_code = r.exit_code,
      msg = r.msg,
      report = r.report,
      complete = complete(r.report),
    }
  end

  local after, err = snapshot()
  local snap = { before = before, after = after, error = err }
  if after ~= nil then
    snap.changed = after ~= before
  end

  print(rex.json.encode{ window_id = window_id, snapshot = snap, reviewers = list })
  rex.stop(code)
end

local function ended(id, state, exit_code, msg)
  local r = results[id]
  if r == nil or r.state ~= nil then
    return
  end

  r.state, r.exit_code, r.msg = state, exit_code, msg
  pending = pending - 1

  if pending == 0 then
    finish(0)
  end
end

rex.on("terminal.child_exited", function(ctx, ev)
  ended(ctx.block_id, "exited", ev.exit_code, ev.error)
end)

rex.on("block_closed", function(ctx, ev)
  ended(ev.block_id, "closed")
end)

local function pane(r)
  local command = r.command

  if r.tee then
    -- sh gets the report path as $0 and the CLI's argv as $@, so no argument needs quoting.
    -- pipefail keeps the CLI's exit status, which tee would otherwise replace.
    command = { "sh", "-c", 'set -o pipefail; "$@" | tee "$0"', r.report }
    for _, word in ipairs(r.command) do
      command[#command + 1] = word
    end
  end

  return rex.layout.block{
    flavor = shell,
    label = r.role,
    options = { command = command, cwd = args.cwd, exit = { on_completion = false } },
  }
end

-- Side by side at equal widths: the first pane takes 1/n of the row, and the rest share what is left.
local function row(i)
  if i == #reviewers then
    return pane(reviewers[i])
  end

  return rex.layout.horizontal(1 / (#reviewers - i + 1), pane(reviewers[i]), row(i + 1))
end

-- The handlers are registered before this timer opens the window, so they hear a reviewer that exits at once.
rex.after(0, function()
  for _, r in ipairs(reviewers) do
    os.remove(r.report)
  end

  local err
  before, err = snapshot()
  if before == nil then
    fail("snapshot: " .. tostring(err), 1)
  end

  local w
  w, err = rex.session.new_window{ window_label = args.window, focus = false, layout = row(1) }
  if err ~= nil then
    fail(err, 1)
  end

  window_id = w.window_id
  local blocks = {}

  for i, id in ipairs(w.block_ids) do
    local r = reviewers[i]
    results[id] = { role = r.role, report = r.report }
    order[i] = id
    blocks[r.role] = id
    pending = pending + 1
  end

  print(rex.json.encode{ window_id = window_id, blocks = blocks })
end)

rex.after(limit, function()
  finish(2)
end)
