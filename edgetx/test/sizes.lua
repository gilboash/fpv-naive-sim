-- Runs the real tool on simulated screens of several sizes, mono and colour.
-- The LCD is strict: a function the real API lacks is an error, every line
-- must be on screen with integer endpoints, every text must fit its screen.
-- Run: lua edgetx/test/sizes.lua
local here = arg[0]:match("^(.*)/test/sizes.lua$") or "edgetx"
local OS = os   -- the radio has no os library: keep ours, hide the global from the script
local fails = 0
local function fail(msg) fails = fails + 1; print("FAIL " .. msg) end

local PROFILES = {
  { name = "mono 128x64  (T14 TX12 Zorro Pocket Boxer)", w = 128, h = 64, colour = false },
  { name = "mono 212x64  (X9D class)",                     w = 212, h = 64, colour = false },
  { name = "mono 128x96",                                   w = 128, h = 96, colour = false },
  { name = "colour 320x240",                                w = 320, h = 240, colour = true },
  { name = "colour 480x272 (TX16S Horus class)",            w = 480, h = 272, colour = true },
  { name = "colour 480x320",                                w = 480, h = 320, colour = true },
  { name = "colour 320x480 (portrait)",                     w = 320, h = 480, colour = true },
}

local EV = { EXIT = 1, ENTER = 2, MENU = 3, NEXT = 4, PREV = 5, INC = 6, DEC = 7, TAP = 9 }

local function runProfile(P)
  -- fresh module state per profile
  for k in pairs(package.loaded) do package.loaded[k] = nil end
  SOLID, DOTTED, FORCE, SMLSIZE, MIDSIZE, RIGHT, CENTER, INVERS, BLINK = 0, 1, 2, 4, 8, 16, 32, 64, 128
  CUSTOM_COLOR = 256
  EVT_VIRTUAL_EXIT, EVT_VIRTUAL_ENTER, EVT_VIRTUAL_MENU, EVT_VIRTUAL_NEXT, EVT_VIRTUAL_PREV, EVT_VIRTUAL_INC, EVT_VIRTUAL_DEC = 1, 2, 3, 4, 5, 6, 7
  EVT_TOUCH_TAP = P.colour and 9 or nil
  LCD_W, LCD_H = P.w, P.h
  local lhExpect = P.colour and 16 or 8
  local cwExpect = P.colour and 8 or 5
  local v = { lines = 0, texts = 0, bad = 0 }
  local function bad(what) v.bad = v.bad + 1; if v.bad <= 5 then print("   " .. P.name .. ": " .. what) end end
  local api = {}
  api.clear = function() end
  api.drawLine = function(a, b, c, d, pat, flags)
    v.lines = v.lines + 1
    for _, n in ipairs({ a, b, c, d }) do
      if n ~= n or math.floor(n) ~= n then bad("non-integer line coord " .. tostring(n)) end
    end
    if a < 0 or c < 0 or a > P.w - 1 or c > P.w - 1 or b < 0 or d < 0 or b > P.h - 1 or d > P.h - 1 then
      bad(string.format("line off screen (%s,%s)-(%s,%s)", a, b, c, d))
    end
  end
  api.drawText = function(x, y, str, flags)
    v.texts = v.texts + 1
    if type(str) ~= "string" then return bad("text not a string") end
    flags = flags or 0
    local cw = cwExpect * ((flags & 8) ~= 0 and 1.6 or 1)
    local len = #str * cw
    local left = x
    if (flags & 16) ~= 0 then left = x - len elseif (flags & 32) ~= 0 then left = x - len / 2 end
    if left < -1 or left + len > P.w + 1 then bad(string.format("text '%s' x=%.0f len=%.0f outside width %d", str, x, len, P.w)) end
    local h = lhExpect * ((flags & 8) ~= 0 and 1.6 or 1)
    if y < 0 or y + h > P.h + 1 then bad(string.format("text '%s' y=%.0f outside height %d", str, y, P.h)) end
  end
  api.drawRectangle = function() end
  if P.colour then
    api.RGB = function(r, g, b) return r * 65536 + g * 256 + b end
    api.setColor = function() end
    api.drawFilledRectangle = function() end
  end
  lcd = setmetatable(api, { __index = function(_, k)
    if k == "setColor" or k == "RGB" then return nil end   -- feature probes read nil on mono radios
    error("lcd." .. tostring(k) .. " does not exist in the EdgeTX API", 2)
  end })

  local tick, sticks = 0, { ail = 0, ele = 0, rud = 0, thr = -1024 }
  getTime = function() return tick end
  getValue = function(n) return sticks[n] end
  getVersion = function() return "2.10.0", "sim" end
  loadScript = function(p) return loadfile(here .. "/SCRIPTS/NacoSim/" .. p:match("([^/]+)$")) end
  local realOpen = io.open
  local logPath, setPath = OS.tmpname(), OS.tmpname()
  io.open = function(p, m)
    if p == "/LOGS/nacosim.csv" or p == "/LOGS/nacosim_last.txt" then p = logPath
    elseif p == "/SCRIPTS/NacoSim/settings.txt" then p = setPath end
    return realOpen(p, m)
  end
  io.write = function(f, ...) return f:write(...) end
  io.read = function(f, n) return f:read(n) end
  io.close = function(f) return f:close() end
  playTone = function() end
  PLAY_NOW = 1

  -- the radio's Lua has no table or os library: hide them from the script
  _G.table, _G.os = nil, nil
  local tool = dofile(here .. "/SCRIPTS/TOOLS/NacoSim.lua")
  tool.init()
  local function frames(n, ticks) for _ = 1, n do tick = tick + (ticks or 5); assert(tool.run(0) == 0, "run returned a stop") end end
  local function key(e) tool.run(e); tick = tick + 5 end

  frames(5)                                  -- splash, THR DOWN
  sticks.thr = 1024; frames(30)              -- climb
  sticks.ail, sticks.ele = 1024, 1024; frames(60)   -- hard roll and pitch
  sticks.ail, sticks.ele, sticks.rud = -1024, -1024, 1024; frames(60)
  sticks.ail, sticks.ele, sticks.rud, sticks.thr = 0, 0, 0, -1024
  frames(500)                                -- fall: crash message and respawn
  -- settings: visit every row, the rates grid and the info screen
  key(EV.MENU)
  for _ = 1, 9 do key(EV.NEXT) end           -- wraps past every row, scrolling
  for _ = 1, 9 do key(EV.PREV) end
  for _ = 1, 4 do key(EV.NEXT) end           -- Rates row
  key(EV.ENTER)                              -- cycle preset
  key(EV.NEXT); key(EV.NEXT)                 -- Edit rates
  key(EV.ENTER)                              -- grid
  for _ = 1, 9 do key(EV.NEXT) end
  key(EV.ENTER); for _ = 1, 3 do key(EV.INC) end; key(EV.ENTER)   -- edit a value
  key(EV.EXIT)                               -- back to main
  key(EV.NEXT)                               -- Info
  key(EV.ENTER); key(EV.ENTER)               -- open info, close it
  key(EV.EXIT)                               -- close the menu
  frames(10)
  -- finish screens: 3 laps and a long race
  local s, cs = tool.peek()
  for _, laps in ipairs({ 3, 10 }) do
    cs.laps, cs.raceLaps, cs.finished, cs.total, cs.best = laps, laps, true, 40 * laps, 38
    cs.lapTimes = {}
    for i = 1, laps do cs.lapTimes[i] = 38 + i end
    frames(2)
    key(EV.ENTER)                            -- again
    s, cs = tool.peek()
  end
  if P.colour then key(EVT_TOUCH_TAP); key(EV.EXIT) end   -- touch opens the menu
  pcall(tool.run, EV.EXIT)
  OS.remove(logPath); OS.remove(setPath)
  if v.bad > 0 then fail(P.name .. ": " .. v.bad .. " violations") end
  print(string.format("%-46s lines %6d  texts %5d  %s", P.name, v.lines, v.texts, v.bad == 0 and "ok" or "FAIL"))
end

for _, P in ipairs(PROFILES) do
  local ok, err = pcall(runProfile, P)
  if not ok then fail(P.name .. ": " .. tostring(err)) end
end
print(fails == 0 and "all sizes ok" or (fails .. " failed"))
OS.exit(fails == 0 and 0 or 1)
