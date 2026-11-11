-- Runs the real tool script against a stub radio: sticks at hover, no crash
-- expected, then a throttle cut to force one. Checks the log gets written.
local here = arg[0]:match("^(.*)/test/tool.lua$") or "edgetx"
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
local logPath = os.tmpname()
local setPath = os.tmpname()
io.open = function(p, m) if p == "/LOGS/nacosim.csv" then p = logPath elseif p == "/SCRIPTS/NacoSim/settings.txt" then p = setPath end return realOpen(p, m) end
io.read = function(f, n) return f:read(n) end
local stdClose = io.close
-- EdgeTX's form: io.write(file, ...) and io.close(file)
io.write = function(f, ...) return f:write(...) end
local tones = 0
playTone = function() tones = tones + 1 end
PLAY_NOW = 1
dofile(here .. "/test/stubs.lua").install(here)
-- the radio's Lua has no table or os library: hide them from the script
local _tmpname, _remove = os.tmpname, os.remove
table, os = nil, nil
local tool = dofile(here .. "/SCRIPTS/TOOLS/NacoSim.lua")
tool.init()
local function frames(n) for _ = 1, n do tick = tick + 5; assert(tool.run(0) == 0) end end
frames(10)                      -- arm on the ground
-- settings menu: MENU opens (the quad pauses), ENTER on Sound toggles, EXIT closes and saves
do
  local s0 = tool.peek()
  local z0 = s0.t
  tool.run(EVT_VIRTUAL_MENU)
  tick = tick + 100; tool.run(0)
  assert(s0.t == z0, "quad must not move while the menu is open")
  tool.run(EVT_VIRTUAL_ENTER)         -- Sound OFF
  tool.run(EVT_VIRTUAL_EXIT)          -- close, save
  local f = assert(realOpen(setPath)); local txt = f:read("a"); f:close()
  print("saved settings: " .. txt:gsub("\n", ""))
  assert(txt:match("^v%d+,(%d)") == "0", "sound should be saved as off")
  tool.run(EVT_VIRTUAL_MENU); tool.run(EVT_VIRTUAL_ENTER); tool.run(EVT_VIRTUAL_EXIT) -- back ON
end
-- map switch: Map row, ENTER takes the next map on the card, the quad is
-- respawned at that map's start and the choice is saved by name
do
  local s0, _, course = tool.peek()
  local before = course.current
  tool.run(EVT_VIRTUAL_MENU)
  tool.run(EVT_VIRTUAL_NEXT)        -- Map row
  tool.run(EVT_VIRTUAL_ENTER)       -- next map
  tool.run(EVT_VIRTUAL_EXIT)        -- close, save, respawn
  local s1, cs1, course1 = tool.peek()
  assert(course1.current ~= before, "map did not change: " .. tostring(course1.current))
  assert(math.abs(s1.x - course1.start[1]) < 1e-6 and math.abs(s1.y - course1.start[2]) < 1e-6, "not at the map start")
  local f = assert(realOpen(setPath)); local txt = f:read("a"); f:close()
  assert(txt:find("," .. course1.current .. ",", 1, true), "map not saved by name: " .. txt)
  print("map switched: " .. before .. " -> " .. course1.current .. ", start " .. course1.start[1] .. "," .. course1.start[2])
  -- back to the oval so the gate-1 test below is unchanged
  local n = 0
  while course1.current ~= "oval" and n < 10 do
    tool.run(EVT_VIRTUAL_MENU); tool.run(EVT_VIRTUAL_NEXT); tool.run(EVT_VIRTUAL_ENTER); tool.run(EVT_VIRTUAL_EXIT)
    n = n + 1
  end
  assert(course1.current == "oval", "could not get back to the oval")
  -- a respawn is disarmed: bring the throttle down so it arms again
  sticks.thr = -1024
  frames(10)
end
-- beep on pass: put the quad just south of gate 1, flying north through it
do
  local s, cs = tool.peek()
  s.x, s.y, s.z, s.vx, s.vy, s.vz = 0, 27, 2, 0, 12, 0
  sticks.thr = -1024 + 2048 * math.sqrt(1 / 8)   -- hover
  local before = tones
  frames(12)
  print("tones on passing gate 1: " .. (tones - before))
  assert(tones - before == 1, "expected one beep for one gate")
  assert(cs.passed == 1, "gate not counted")
end
sticks.thr = 1024; frames(40)   -- full throttle climb
sticks.thr = -1024; frames(400) -- cut: falls and crashes
tool.run(EVT_VIRTUAL_EXIT)
local f = assert(realOpen(logPath)); local txt = f:read("a"); f:close()
local lines = 0; for _ in txt:gmatch("\n") do lines = lines + 1 end
print("log lines: " .. lines, txt:find("CRASH") and "crash logged" or "NO CRASH LINE")
assert(lines > 100 and txt:find("CRASH"), "log missing")
_remove(logPath); _remove(setPath)
print("tones: " .. tones)
print("tool ok")
