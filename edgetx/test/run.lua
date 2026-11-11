-- Headless checks for the model and the course. Run: lua edgetx/test/run.lua
local here = arg[0]:match("^(.*)/test/run.lua$") or "edgetx"
here_dir = here
EVT_VIRTUAL_EXIT, EVT_VIRTUAL_ENTER, EVT_VIRTUAL_MENU, EVT_VIRTUAL_NEXT, EVT_VIRTUAL_PREV, EVT_VIRTUAL_INC, EVT_VIRTUAL_DEC = 1, 2, 3, 4, 5, 6, 7
INVERS, BLINK = 64, 128
LCD_W, LCD_H = 128, 64
loadScript = function(p) return loadfile(here_dir .. "/SCRIPTS/NacoSim/" .. p:match("([^/]+)$")) end
package.path = here .. "/SCRIPTS/NacoSim/?.lua;" .. package.path
local M = require("model")
local C = require("course")

local fails, count = 0, 0
local function check(name, ok, detail)
  count = count + 1
  if not ok then fails = fails + 1 end
  print((ok and "ok   " or "FAIL ") .. name .. (detail and ("  " .. detail) or ""))
end
local function near(a, b, tol) return math.abs(a - b) <= tol end
local DEG = 180 / math.pi
local HOVER = math.sqrt(1 / M.cfg.twr)

-- 1. rate at full stick matches the configured deg/s
check("roll max 512", near(M.rate(1, 1), 512.2, 1), M.rate(1, 1))
check("pitch max 439", near(M.rate(2, 1), 439, 1), M.rate(2, 1))
check("yaw max 429", near(M.rate(3, 1), 428.6 + 0, 4), M.rate(3, 1))
check("centre small", math.abs(M.rate(1, 0.01)) < 5)

-- helper
local function fly(s, secs, ail, ele, rud, thr)
  for _ = 1, math.floor(secs / 0.01 + 0.5) do M.step(s, 0.01, ail, ele, rud, thr, true) end
end

-- 2. achieved roll rate settles to the curve (0.5 s of full right roll at altitude)
do
  local s = M.new(0, 0, 100, 0)
  fly(s, 0.3, 1, 0, 0, HOVER)
  check("roll rate settles", near(s.w1 * DEG, 512, 8), s.w1 * DEG)
end

-- 3. hover holds height
do
  local s = M.new(0, 0, 50, 0)
  fly(s, 2, 0, 0, 0, HOVER)
  check("hover holds", math.abs(s.z - 50) < 0.5, s.z)
end

-- 4. directions: heading north; forward stick -> moves north, nose down
do
  local s = M.new(0, 0, 50, 0)
  fly(s, 0.1, 0, 0.3, 0, HOVER)         -- pitch forward briefly
  check("pitch fwd = nose down", s.r[3] < -0.05, s.r[3])
  fly(s, 1.0, 0, 0, 0, HOVER * 1.1)
  check("pitch fwd flies north", s.vy > 1 and math.abs(s.vx) < 0.3, s.vy .. " " .. s.vx)
end
do
  local s = M.new(0, 0, 50, 0)
  fly(s, 0.1, 0.3, 0, 0, HOVER)
  fly(s, 1.0, 0, 0, 0, HOVER * 1.1)
  check("roll right flies east", s.vx > 1 and math.abs(s.vy) < 0.3, s.vx .. " " .. s.vy)
end
do
  local s = M.new(0, 0, 50, 0)
  fly(s, 0.3, 0, 0, 0.3, HOVER)
  check("yaw right turns clockwise (nose east)", s.r[1] > 0.1, s.r[1])
end

-- 5. orthonormal after a long tumble
do
  local s = M.new(0, 0, 500, 0)
  fly(s, 20, 0.8, 0.5, -0.7, HOVER)
  local r = s.r
  local d = r[1] * r[4] + r[2] * r[5] + r[3] * r[6]
  local n = r[1] * r[1] + r[2] * r[2] + r[3] * r[3]
  check("orthonormal after 20 s", math.abs(d) < 1e-6 and near(n, 1, 1e-6), d .. " " .. n)
end

-- 6. determinism
do
  local function run()
    local s = M.new(0, 0, 50, 0)
    fly(s, 1, 0.4, 0.2, -0.1, HOVER * 1.2)
    return s.x .. "," .. s.y .. "," .. s.z
  end
  check("deterministic", run() == run())
end

-- 7. crash and ground
do
  local s = M.new(0, 0, 30, 0)
  fly(s, 4, 0, 0, 0, 0)
  check("falls and crashes", s.crashed and s.why ~= nil, s.why)
  local soft = M.new(0, 0, 1.5, 0)
  fly(soft, 3, 0, 0, 0, HOVER * 0.9)
  check("a soft landing is not a crash", not soft.crashed, tostring(soft.why))
  local g = M.new(0, 0, 0, 0)
  fly(g, 1, 0, 0, 0, 0)
  check("sits on the ground", not g.crashed and g.z == 0)
  fly(g, 1, 0, 0, 0, 1.0)
  check("full throttle lifts off", g.z > 3, g.z)
end

-- 8. gates: pass forward, not backward, not outside the aperture
do
  local gt = C.gates[1]                  -- (0,30,2) heading north
  local function pass(x, z, dir)
    local c = C.new()
    local y0, y1 = 30 - 3 * dir, 30 + 3 * dir
    local hit = false
    for i = 0, 60 do
      local y = y0 + (y1 - y0) * i / 60
      hit = C.update(c, x, y, z, i * 0.01) or hit
    end
    return hit
  end
  check("gate: forward through centre", pass(0, 2, 1))
  check("gate: wrong way", not pass(0, 2, -1))
  check("gate: too far left", not pass(-3, 2, 1))
  check("gate: too high", not pass(0, 5, 1))
  check("gate: edge inside", pass(1.9, 2, 1))
end

-- 9. a lap counts gate 1 -> 8 -> gate 1
do
  local c = C.new()
  local t = 0
  local function through(g)
    local ox, oy = -g.nx * 3, -g.ny * 3
    for i = 0, 6 do
      local f = i / 6
      C.update(c, g[1] + ox * (1 - f) - ox * f, g[2] + oy * (1 - f) - oy * f, g[3], t)
      t = t + 0.1
    end
  end
  for _ = 1, 2 do for i = 1, #C.gates do through(C.gates[i]) end end
  through(C.gates[1])
  check("two circuits count laps", c.laps == 2, "laps=" .. c.laps .. " passed=" .. c.passed)
end

-- race: three laps, timed hole shot to final gate-1 pass
do
  local c = C.new(3)
  local t = 0
  local function through(g)
    for i = 0, 6 do
      local f = i / 6
      C.update(c, g[1] - g.nx * (3 - 6 * f), g[2] - g.ny * (3 - 6 * f), g[3], t)
      t = t + 0.5
    end
  end
  for _ = 1, 3 do for i = 1, #C.gates do through(C.gates[i]) end end
  check("not finished before the closing pass", not c.finished and c.laps == 2, "laps=" .. c.laps)
  through(C.gates[1])
  local sum = 0
  for i = 1, 3 do sum = sum + (c.lapTimes[i] or 0) end
  check("three laps finish the race", c.finished and c.laps == 3, "laps=" .. c.laps)
  check("total = sum of laps", near(c.total, sum, 1e-6), c.total .. " vs " .. sum)
  local laps = c.laps
  through(C.gates[2]); through(C.gates[1])
  check("nothing counts after the finish", c.laps == laps)
  check("time format", C.fmt(52.34) == "52.3" and C.fmt(65.3) == "1:05.3", C.fmt(65.3))
end

-- 10. the view draws a whole frame on a fresh state and mid-flight, with a
-- stub LCD (catches nil fields and bad arithmetic that only the radio showed)
do
  local lines, texts = 0, 0
  SOLID, DOTTED, FORCE, SMLSIZE, MIDSIZE, RIGHT, CENTER = 0, 1, 2, 4, 8, 16, 32
  lcd = {
    clear = function() lines, texts = 0, 0 end,
    drawLine = function(a, b, c, d) assert(a == a and b == b and c == c and d == d, "NaN line"); lines = lines + 1 end,
    drawText = function(x, y, t) assert(type(t) == "string"); texts = texts + 1 end,
  }
  local V = require("view")
  local s = M.new(0, 0, 0, 0)
  local cs = C.new()
  V.draw(s, C, cs, {})
  check("view draws a fresh frame", lines > 5 and texts >= 3, lines .. " lines")
  fly(s, 1, 0.3, 0.3, 0.1, HOVER * 1.3)
  V.draw(s, C, cs, { msg = "CRASH", ms = 12 })
  check("view draws mid-flight", lines > 5)
end

-- 11. no line may reach the LCD outside the screen, at any attitude (the
-- radio's script ended on steep roll/pitch when this was not so)
do
  local bad, worst = 0, 0
  lcd.drawLine = function(a, b, c, d)
    for _, v in ipairs({ a, b, c, d }) do
      if v ~= v or v < -1 or v > 128 or math.floor(v) ~= v then bad = bad + 1 end
      if math.abs(v) > worst then worst = math.abs(v) end
    end
  end
  local V = require("view")
  local s = M.new(3, 4, 5, 0)
  local cs = C.new()
  for roll = -180, 180, 15 do
    for pitch = -180, 180, 15 do
      local cr, sr, cp, sp = math.cos(roll / DEG), math.sin(roll / DEG), math.cos(pitch / DEG), math.sin(pitch / DEG)
      local r = s.r
      -- body frame: pitch about the left axis, then roll about the forward axis
      local bx, by, bz = { cp, 0, -sp }, { 0, 1, 0 }, { sp, 0, cp }
      -- (heading north: forward = y), build in a x-forward frame then map x->y, y->-x
      local function map(v) return { -v[2], v[1], v[3] } end
      local fx, fy, fz = map(bx), map(by), map(bz)
      r[1], r[2], r[3] = fx[1], fx[2], fx[3]
      r[4], r[5], r[6] = fy[1] * cr + fz[1] * sr, fy[2] * cr + fz[2] * sr, fy[3] * cr + fz[3] * sr
      r[7], r[8], r[9] = -fy[1] * sr + fz[1] * cr, -fy[2] * sr + fz[2] * cr, -fy[3] * sr + fz[3] * cr
      V.draw(s, C, cs, {})
    end
  end
  check("every attitude draws only on-screen integer lines", bad == 0, "bad=" .. bad .. " worst=" .. worst)
end

-- 12. the next-gate marker always shows: diamond when in view, arrow when not
do
  local V = require("view")
  local drawn = 0
  lcd.drawLine = function(a, b, c, d) drawn = drawn + 1 end
  local cs = C.new()
  local s = M.new(0, 0, 2, 0)                 -- facing north, gate 1 ahead
  local function marks(heading)
    M.reset(s, 0, 0, 2, heading)
    drawn = 0
    V.draw(s, C, cs, {})
    return drawn
  end
  local ahead = marks(0)
  local behind = marks(180)                   -- gate behind: gates not drawn, arrow is
  check("marker with the gate ahead", ahead >= 8, ahead)
  check("arrow when the gate is behind", behind >= 3, behind)
end

-- 13. settings: presets change the rates, edits persist, the menu draws
do
  local St = require("settings")
  St.setDisplay(require("view").display)
  local path = os.tmpname()
  local realOpen = io.open
  local oldOpen = io.open
  io.open = function(p, m) if p == "/SCRIPTS/NacoSim/settings.txt" then p = path end return oldOpen(p, m) end
  local oldWrite, oldRead = io.write, io.read
  io.write = function(f, ...) return f:write(...) end
  io.read = function(f, n) return f:read(n) end
  lcd.drawLine = function() end
  C.select(1)
  St.open()
  St.preset = 1
  St.apply(M)
  check("quad preset = 512 roll", near(M.rate(1, 1), 512.2, 1))
  -- main menu: cursor 3 = Rates, ENTER cycles the preset
  for _ = 1, 4 do St.event(EVT_VIRTUAL_NEXT, M, C) end
  St.event(EVT_VIRTUAL_ENTER, M, C)
  check("rates preset cycles to BF default (667 roll)", near(M.rate(1, 1), 666.7, 1), M.rate(1, 1))
  -- tilt: item 4, ENTER steps by 5 and wraps after 60
  St.event(EVT_VIRTUAL_PREV, M, C)
  St.event(EVT_VIRTUAL_ENTER, M, C)
  check("tilt steps 25 -> 30", St.tilt == 30, St.tilt)
  for _ = 1, 7 do St.event(EVT_VIRTUAL_ENTER, M, C) end
  check("tilt wraps to 0 after 60", St.tilt == 0, St.tilt)
  St.tilt = 25
  St.event(EVT_VIRTUAL_NEXT, M, C)   -- back on Rates
  -- sound toggle: cursor wraps back to item 1
  for _ = 1, 4 do St.event(EVT_VIRTUAL_NEXT, M, C) end
  St.event(EVT_VIRTUAL_ENTER, M, C)
  check("sound toggles off", St.sound == false)
  -- edit rates: item 4, ENTER opens grid, ENTER edits roll rcRate, + a few
  for _ = 1, 3 do St.event(EVT_VIRTUAL_PREV, M, C) end -- 1 -> Back -> Info -> Edit rates
  St.event(EVT_VIRTUAL_ENTER, M, C)   -- open the grid
  St.event(EVT_VIRTUAL_ENTER, M, C)   -- edit roll rcRate
  for _ = 1, 5 do St.event(EVT_VIRTUAL_INC, M, C) end
  check("editing raises roll rcRate by 0.05", near(St.rates[1], 1.05, 1e-6), St.rates[1])
  St.event(EVT_VIRTUAL_ENTER, M, C)   -- stop editing
  St.event(EVT_VIRTUAL_EXIT, M, C)    -- back to main
  St.draw(M, C)
  check("saved", St.save())
  St.sound, St.rates[1] = true, 0.5
  check("loaded", St.load(C) and St.sound == false and near(St.rates[1], 1.05, 1e-6))
  check("a closed menu returns true on EXIT", St.event(EVT_VIRTUAL_EXIT, M, C) == true)
  St.sound, St.preset = true, 1
  for i = 1, 9 do St.rates[i] = St.presets[1][2][i] end
  St.apply(M)
  os.remove(path)
  io.open, io.write, io.read = oldOpen, oldWrite, oldRead
end

-- the finish screen lists total and laps
do
  local V = require("view")
  local texts = {}
  lcd.drawLine = function() end
  lcd.clear = function() texts = {} end
  lcd.drawText = function(x, y, t) texts[#texts + 1] = t end
  local c = C.new(3)
  c.laps, c.finished, c.total, c.best = 3, true, 154.2, 50.1
  c.lapTimes = { 52.0, 50.1, 52.1 }
  V.finish(C, c)
  local all = table.concat(texts, "|")
  check("finish screen shows total and every lap", all:find("2:34.2") and all:find("Lap 1") and all:find("Lap 3") and all:find("best"), all)
end

-- camera tilt moves the picture: the horizon sits lower with more up-tilt
do
  local V = require("view")
  local ys = {}
  lcd.clear = function() end
  lcd.drawText = function() end
  local firstY
  lcd.drawLine = function(a, b, c, d) if not firstY then firstY = b end end
  local s = M.new(0, 0, 3, 0)
  local cs = C.new()
  for _, deg in ipairs({ 0, 25, 50 }) do
    V.setTilt(deg)
    firstY = nil
    V.draw(s, C, cs, {})
    ys[#ys + 1] = firstY
  end
  V.setTilt(25)
  check("more tilt puts the horizon lower", ys[1] < ys[2] and ys[2] < ys[3], table.concat(ys, ","))
end

-- settings versioning: legacy files migrate, a newer file is ignored
do
  local St = require("settings")
  local path = os.tmpname()
  local oldOpen, oldWrite, oldRead = io.open, io.write, io.read
  io.open = function(p, m) if p == "/SCRIPTS/NacoSim/settings.txt" then p = path end return oldOpen(p, m) end
  io.write = function(f, ...) return f:write(...) end
  io.read = function(f, n) return f:read(n) end
  local function put(txt) local f = oldOpen(path, "w"); f:write(txt); f:close() end
  local function reset() St.sound, St.map, St.preset, St.laps, St.tilt = true, 1, 1, 3, 25 end
  local r12 = "0,1,1,1.05,0.59,0.01,0.90,0.59,0.01,0.90,0.58,0.10"
  reset(); put(r12 .. "\n")
  check("v1 (12 numbers) migrates: sound off, laps 3, tilt 25", St.load(C) and not St.sound and St.laps == 3 and St.tilt == 25)
  reset(); put(r12 .. ",5\n")
  check("v2 (13 numbers) migrates: laps 5, tilt 25", St.load(C) and St.laps == 5 and St.tilt == 25)
  reset(); put(r12 .. ",10,40\n")
  check("v3 (14 numbers, no tag) loads", St.load(C) and St.laps == 10 and St.tilt == 40)
  reset(); St.laps, St.tilt = 5, 15
  check("save writes the version tag", St.save())
  local f = oldOpen(path); local txt = f:read("a"); f:close()
  check("file starts with v" .. St.FORMAT, txt:sub(1, 3) == "v" .. St.FORMAT .. ",", txt)
  reset()
  check("tagged file loads", St.load(C) and St.laps == 5 and St.tilt == 15)
  put("v99,1,1,1," .. string.rep("0.5,", 9) .. "3,25\n")
  reset()
  check("a newer file is ignored, defaults stay", not St.load(C) and St.laps == 3 and St.loadNote ~= nil, tostring(St.loadNote))
  put(""); reset()
  check("an empty file (a save that was cut off) falls back to defaults", not St.load(C))
  put("garbage,1,2\n"); reset()
  check("garbage falls back to defaults", not St.load(C))
  os.remove(path)
  io.open, io.write, io.read = oldOpen, oldWrite, oldRead
end

print(string.format("%d checks, %d failed", count, fails))
os.exit(fails == 0 and 0 or 1)
