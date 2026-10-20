-- Open a pane per one-shot reviewer, wait until every reviewer has ended, and report.
--
--   rex do --fail-fast -s SESSION -b BLOCK review.lua --args @/abs/run/PR1-R1-review.json
--
-- references/rex-ops.md#rounds holds the contract, and references/rex-ops.md#teardown says how to close the panes.
--
-- The commands live in the spec file, so this watcher's own command line names no reviewer CLI,
-- and a pkill -f aimed at one leaves the watcher running.
local shell = "com.superlogical.terminal.shell"
local terminal = "com.superlogical.terminal"
local args = rex.args
local reviewers = args.reviewers
local limit = args.limit or 3600
-- Seconds a reviewer gets to exit after Ctrl-C before its pane is closed.
local grace = 15
local by_block = {}
local pending
local stopping = false
local before

-- One throwaway index serves both snapshots, so the second rehashes only what changed and the real index stays untouched.
local index = os.tmpname()
os.remove(index)

local function fail(message, code)
  os.remove(index)
  io.stderr:write(message .. "\n")
  rex.stop(code)
end

if type(args.cwd) ~= "string" or type(reviewers) ~= "table" or #reviewers == 0 then
  fail("--args takes cwd and a non-empty reviewers list", 64)
end

if args.window == nil then
  if rex.block_id == nil then
    fail("pass -b with the block to split beside, or set window in --args", 64)
  end
elseif type(args.window) ~= "string" then
  fail("window takes a tab label", 64)
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

-- read-tree -m first puts every tracked file back in the index and keeps the stat data of unchanged ones.
-- Without it, add -A skips a tracked file under an ignored directory once an earlier snapshot dropped it,
-- so a reviewer who restores that file leaves the hash unchanged.
local steps = {
  { "git", "read-tree", "-m", "HEAD" },
  { "git", "add", "-A" },
  { "git", "write-tree" },
}

-- The tree hash of the whole worktree.
-- git status lists names only, so it misses a reviewer's edit to a file the executor already changed. The hash changes.
-- The timeout bounds a git add stuck in a clean filter, such as LFS waiting for credentials.
local function snapshot()
  local opts = { cwd = args.cwd, env = { GIT_INDEX_FILE = index }, timeout = 120 }
  local r, err

  for _, argv in ipairs(steps) do
    r, err = rex.exec(argv, opts)
    if r == nil then
      return nil, err
    end
    if r.timed_out then
      return nil, table.concat(argv, " ") .. ": timed out after " .. opts.timeout .. " seconds"
    end
    if not r.ok then
      return nil, table.concat(argv, " ") .. ": " .. r.stderr:gsub("%s+$", "")
    end
  end

  return (r.stdout:gsub("%s+$", ""))
end

-- A close_err skips the final snapshot, since a reviewer whose pane would not close may still run.
local function finish(code, close_err)
  local list = {}

  for _, r in ipairs(reviewers) do
    list[#list + 1] = {
      role = r.role,
      block_id = r.block_id,
      state = r.state,
      exit_code = r.exit_code,
      msg = r.msg,
      report = r.report,
      complete = complete(r.report),
      open = r.open,
    }
  end

  local snap = { before = before, error = close_err }
  if close_err == nil then
    snap.after, snap.error = snapshot()
  end
  if snap.after ~= nil then
    snap.changed = snap.after ~= before
  else
    code = 1
  end

  os.remove(index)
  print(rex.json.encode{ snapshot = snap, reviewers = list })
  rex.stop(code)
end

local function ended(id, state, exit_code, msg)
  local r = by_block[id]
  if r == nil or r.state ~= nil then
    return
  end

  r.state, r.exit_code, r.msg = stopping and "stopped" or state, exit_code, msg
  pending = pending - 1

  if pending == 0 then
    finish(stopping and 2 or 0)
  end
end

rex.on("terminal.child_exited", function(ctx, ev)
  ended(ctx.block_id, "exited", ev.exit_code, ev.error)
end)

rex.on("block_closed", function(ctx, ev)
  local r = by_block[ev.block_id]
  if r ~= nil then
    r.open = false
  end
  ended(ev.block_id, "closed")
end)

-- Ctrl-C through the terminal, as a user would press it, so the pane keeps the reviewer's last output.
-- A reviewer that ignores it has its pane closed after the grace. The final snapshot waits until every reviewer has ended.
local function stop()
  stopping = true

  for _, r in ipairs(reviewers) do
    if r.state == nil then
      -- A failed write leaves the reviewer to the close below.
      rex.block.call(terminal, "write", { block_id = r.block_id, data = "\3" })
    end
  end

  rex.after(grace, function()
    local errs = {}

    for _, r in ipairs(reviewers) do
      if r.state == nil then
        -- rex.call never fills in session_id, and block.close requires one.
        local _, err = rex.call("block.close", { session_id = rex.session_id, block_id = r.block_id })
        -- A block someone else closed meanwhile fails with not_found, and counts as closed.
        if err == nil or tostring(err):find("not_found", 1, true) then
          r.open = false
          ended(r.block_id, "stopped")
        else
          errs[#errs + 1] = "block.close " .. r.block_id .. ": " .. tostring(err)
        end
      end
    end

    if #errs > 0 then
      finish(1, table.concat(errs, "; "))
    end
  end)
end

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

-- A new tab with window set, else a split below the block the script runs against.
local function open()
  if args.window ~= nil then
    return rex.session.new_window{ window_label = args.window, focus = false, layout = row(1) }
  end

  return rex.session.new_split{
    anchor_id = rex.block_id,
    direction = "vertical",
    side = "after",
    focus = false,
    layout = row(1),
  }
end

-- The handlers are registered before this timer opens the panes, so they hear a reviewer that exits at once.
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
  w, err = open()
  if err ~= nil then
    fail(err, 1)
  end

  local blocks = {}

  for i, id in ipairs(w.block_ids) do
    local r = reviewers[i]
    r.block_id = id
    r.open = true
    by_block[id] = r
    blocks[r.role] = id
  end
  pending = #w.block_ids

  print(rex.json.encode{ blocks = blocks })

  -- The limit counts from the panes' start, so a slow first snapshot never eats into it.
  rex.after(limit, stop)
end)
