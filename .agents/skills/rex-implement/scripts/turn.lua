-- Submit at most one input to the agent in a Rex terminal block, and wait for the next turn to settle.
--
--   rex do --fail-fast -s SESSION turn.lua block=BLOCK_ID text='Read and follow /abs/P1-review.md.'   types the text, presses Return
--   rex do --fail-fast -s SESSION turn.lua block=BLOCK_ID key=3                                        presses one key: a character, enter or escape
--   rex do --fail-fast -s SESSION turn.lua block=BLOCK_ID after=UPDATED_AT                             sends nothing, waits for the running or next turn
--
-- A turn has settled once the block reported working and its latest report is
-- anything else, or once the CLI exits or its block closes. Prints the settling
-- record as JSON with state, and kind, msg and updated_at when set. Besides the
-- agent's own states, "exited" means the CLI quit, "removed" means its status
-- record was cleared, and "closed" means its block closed.
-- after= is the updated_at of the last settling record: when waiting, a record
-- that has changed since then and is not working settles at once.
-- Exit 0: settled. 1: the input could not be sent, or the script failed.
-- 2: no working report within start= seconds (default 20 after sending, 600 when waiting). 64: bad arguments.
local terminal = "com.superlogical.terminal"
local keys = { enter = "\r", escape = "\27" }
local block = rex.args.block
local text = rex.args.text
local key = rex.args.key
local after = rex.args.after
local working = false

local function fail(message, code)
  io.stderr:write(message .. "\n")
  rex.stop(code)
end

-- Events carry the full block ID, so a label or ID suffix would never match.
if type(block) ~= "string" or not block:match("^block:") then
  fail("block= takes a full block ID", 64)
end

if text ~= nil and key ~= nil then
  fail("pass at most one of text= and key=", 64)
end

if key ~= nil then
  key = tostring(key)

  if #key > 1 and keys[key] == nil then
    fail("key= takes one character, enter or escape; send other keys with rex send-key", 64)
  end
end

-- Waiting has a bound too: a backgrounded command that never ends never resumes the agent.
local start = rex.args.start
if start == nil then
  start = (text ~= nil or key ~= nil) and 20 or 600
end

local function settle(record)
  print(rex.json.encode(record))
  rex.stop(0)
end

local function write(data)
  local _, err = rex.block.call(terminal, "write", { block_id = block, data = data })
  if err ~= nil then
    fail(err, 1)
  end
end

rex.on("terminal.program_status_changed", function(ctx, ev)
  if ctx.block_id ~= block or (ev.id or "") ~= "" then
    return
  end

  local r = ev.record
  if r.state == "working" then
    working = true
  elseif working then
    settle{ state = r.state, kind = r.kind, msg = r.msg, updated_at = r.updated_at }
  end
end)

rex.on("terminal.program_status_removed", function(ctx, ev)
  if ctx.block_id ~= block or not working then
    return
  end

  for _, id in ipairs(ev.ids) do
    if id == "" then
      settle{ state = "removed", msg = ev.reason }
    end
  end
end)

rex.on("terminal.child_exited", function(ctx, ev)
  if ctx.block_id == block then
    settle{ state = "exited", msg = ev.error or ("exit status " .. ev.exit_code) }
  end
end)

rex.on("block_closed", function(ctx, ev)
  if ev.block_id == block then
    settle{ state = "closed" }
  end
end)

-- The handlers are registered before this timer sends anything, so they hear the whole turn.
rex.after(0, function()
  if text ~= nil then
    write(tostring(text))
    -- Codex leaves a long prompt unsent when Return follows the text at once.
    rex.sleep(1)
    write(keys.enter)

    return
  end

  if key ~= nil then
    write(keys[key] or key)

    return
  end

  -- Waiting only: a turn already running counts, and so does one that ended since after=.
  local status, err = rex.block.call(terminal, "program_status", { block_id = block })
  if err ~= nil then
    fail(err, 1)
  end

  for _, r in ipairs(status.records) do
    if r.id == nil then
      if r.state == "working" then
        working = true
      elseif after ~= nil and r.updated_at ~= tostring(after) then
        settle{ state = r.state, kind = r.kind, msg = r.msg, updated_at = r.updated_at }
      end
    end
  end
end)

rex.after(start, function()
  if not working then
    fail("no working report within " .. start .. "s", 2)
  end
end)
