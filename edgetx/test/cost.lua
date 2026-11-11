-- Lua VM instructions per run() call, worst case over a flight with gates in
-- view. EdgeTX kills a script that uses too many in one call.
local here = arg[0]:match("^(.*)/test/cost.lua$") or "edgetx"
SOLID, DOTTED, FORCE, SMLSIZE, MIDSIZE, RIGHT, CENTER = 0, 1, 2, 4, 8, 16, 32
EVT_VIRTUAL_EXIT, EVT_VIRTUAL_ENTER, EVT_VIRTUAL_MENU, EVT_VIRTUAL_NEXT, EVT_VIRTUAL_PREV, EVT_VIRTUAL_INC, EVT_VIRTUAL_DEC = 1, 2, 3, 4, 5, 6, 7
INVERS, BLINK = 64, 128
LCD_W, LCD_H = 128, 64
lcd = { clear = function() end, drawLine = function() end, drawText = function() end }
local tick, sticks = 0, { ail = 0, ele = 0, rud = 0, thr = -1024 }
getTime = function() return tick end
getValue = function(n) return sticks[n] end
loadScript = function(p) return loadfile(here .. "/SCRIPTS/NacoSim/" .. p:match("([^/]+)$")) end
local realOpen = io.open
io.open = function(p, m) if p:find("^/LOGS") or p:find("settings.txt") then return nil end return realOpen(p, m) end
dofile(here .. "/test/stubs.lua").install(here)
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
print(string.format("oval flight: avg %d  worst %d instructions per run() call (5 steps)", math.floor(sum / calls), worst))

-- every checkpoint of every map, seen from in front and from behind: the most
-- lines a frame can draw is what the instruction budget has to cover
local s, cs, course, model = tool.peek()
for _ = 1, #course.keys do
  tool.run(EVT_VIRTUAL_MENU); tool.run(EVT_VIRTUAL_NEXT); tool.run(EVT_VIRTUAL_ENTER); tool.run(EVT_VIRTUAL_EXIT)
  local s2, cs2, c2 = tool.peek()
  local mw, at = 0, 0
  for i = 1, #c2.gates do
    local g = c2.gates[i]
    for _, back in ipairs({ 0, 180 }) do
      cs2.nxt = i
      model.reset(s2, g[1] - g.nx * 8, g[2] - g.ny * 8, 3, (g[4] + back) % 360)
      n = 0
      tick = tick + 5
      debug.sethook(hook, "", 100)
      tool.run(0)
      debug.sethook()
      if n > mw then mw, at = n, i end
    end
  end
  print(string.format("map %-12s %2d checkpoints: worst frame %d instructions (at checkpoint %d)", c2.current, #c2.gates, mw, at))
end
