-- A module that will not compile ("not enough memory") must show a message and
-- leave on EXIT, not raise a raw error; a load that fails once must be retried.
local here = arg[0]:match("^(.*)/test/lowmem.lua$") or "edgetx"
EVT_VIRTUAL_EXIT, EVT_VIRTUAL_ENTER, EVT_VIRTUAL_MENU = 1, 2, 3
SMLSIZE, LCD_W, LCD_H = 4, 128, 64
local texts, tick = {}, 0
lcd = { clear = function() texts = {} end, drawLine = function() end, drawText = function(_, _, t) texts[#texts + 1] = t end }
getTime = function() return tick end
getValue = function() return 0 end
local realOpen = io.open
io.open = function(p, m) if p:find("^/LOGS") or p:find("settings.txt") then return nil end return realOpen(p, m) end
local fails, calls = 0, 0
loadScript = function(p)
  calls = calls + 1
  if p:find("view.lua") and calls < 100 then fails = fails + 1; return nil, "not enough memory" end
  return loadfile(here .. "/SCRIPTS/NacoSim/" .. p:match("([^/]+)$"))
end
local tool = dofile(here .. "/SCRIPTS/TOOLS/NacoSim.lua")
tool.init()
assert(fails == 2, "a failed load should be retried once, got " .. fails)
assert(tool.run(0) == 0, "boot failure screen should stay up")
local all = table.concat(texts, " ")
assert(all:find("not enough memory") and all:find("NacoMem"), "message missing: " .. all)
assert(tool.run(EVT_VIRTUAL_EXIT) == 1, "EXIT should leave")
-- one failure then success: retried and runs
fails, calls = 0, 0
loadScript = function(p)
  calls = calls + 1
  if p:find("course.lua") and fails == 0 then fails = 1; return nil, "not enough memory" end
  return loadfile(here .. "/SCRIPTS/NacoSim/" .. p:match("([^/]+)$"))
end
dir = function() return function() return nil end end
io.write = function() end; io.close = function() end
local t2 = dofile(here .. "/SCRIPTS/TOOLS/NacoSim.lua")
t2.init()
assert(fails == 1 and t2.peek() ~= nil, "retry should recover")
print("lowmem ok")
