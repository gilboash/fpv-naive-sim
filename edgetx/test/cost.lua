-- Lua VM instructions per run() call, worst case over a flight with gates in
-- view. EdgeTX kills a script that uses too many in one call.
local here = arg[0]:match("^(.*)/test/cost.lua$") or "edgetx"
SOLID, DOTTED, FORCE, SMLSIZE, MIDSIZE, RIGHT, CENTER = 0, 1, 2, 4, 8, 16, 32
EVT_VIRTUAL_EXIT, EVT_VIRTUAL_ENTER = 1, 2
LCD_W, LCD_H = 128, 64
lcd = { clear = function() end, drawLine = function() end, drawText = function() end }
local tick, sticks = 0, { ail = 0, ele = 0, rud = 0, thr = -1024 }
getTime = function() return tick end
getValue = function(n) return sticks[n] end
loadScript = function(p) return loadfile(here .. "/SCRIPTS/NacoSim/" .. p:match("([^/]+)$")) end
io.open = function() return nil end
local tool = dofile(here .. "/SCRIPTS/TOOLS/NacoSim.lua")
tool.init()
local n, worst, sum, calls = 0, 0, 0, 0
local function hook() n = n + 100 end
local function frames(k, ticks)
  for _ = 1, k do
    tick = tick + ticks
    n = 0
    debug.sethook(hook, "", 100)
    tool.run(0)
    debug.sethook()
    calls = calls + 1; sum = sum + n
    if n > worst then worst = n end
  end
end
frames(10, 5)
sticks.thr = 0; sticks.ele = 300; frames(30, 5)
sticks.ele = 0; sticks.thr = -300; frames(300, 5)
print(string.format("avg %d  worst %d instructions per run() call (5 steps)", math.floor(sum / calls), worst))
