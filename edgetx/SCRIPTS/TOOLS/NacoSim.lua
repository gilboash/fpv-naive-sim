-- NacoSim: a rate-mode quad you fly with the radio's own sticks.
-- EXIT leaves, ENTER respawns, MENU (or a PAGE key) opens the settings.
-- Roll/pitch/yaw/throttle come from getValue.
local base = "/SCRIPTS/NacoSim/"
local model, course, view, settings
local menu, hint = false, 0
local D
local fpsT, fpsN, fps = 0, 0, 0
local s, cs
local armed, lastTick, crashAt, acc = false, 0, 0, 0
local flip = { ail = 1, ele = 1, rud = 1 } -- set -1 if a direction is reversed on your radio
local showMs, frameMs = false, 0
local rows, buf, nbuf = 0, {}, 0
local LOG = "/LOGS/nacosim.csv"

-- Lines are buffered about a second, then appended with open/write/close: a
-- file held open across frames was never flushed on this radio (0 bytes).
local function flush()
  if nbuf == 0 then return end
  local f = io.open(LOG, "a")
  if f then
    for i = 1, nbuf do io.write(f, buf[i]); buf[i] = nil end
    io.close(f)
  end
  -- status file, overwritten: survives even if appending to the log stops
  local g = io.open("/LOGS/nacosim_last.txt", "w")
  if g then
    io.write(g, string.format("NacoSim %s t=%.2f rows=%d mem=%dk tick=%d crashed=%s why=%s\n", settings.APP, s.t, rows, math.floor(collectgarbage("count")), getTime(), tostring(s.crashed), tostring(s.why)))
    io.close(g)
  end
  nbuf = 0
end
local function logRow(t, ail, ele, rud, thr, note)
  if rows > 8000 then return end
  rows = rows + 1
  local r = s.r
  local line = string.format("%.2f,%.3f,%.3f,%.3f,%.3f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.2f,%.2f,%.2f,%.2f,%.2f,%d,%d,%s\n",
    t, ail, ele, rud, thr, s.x, s.y, s.z, s.vx, s.vy, s.vz, r[3], r[9], s.w1, s.w2, s.w3, armed and 1 or 0, math.floor(collectgarbage("count")), note or "")
  nbuf = nbuf + 1
  buf[nbuf] = line
  if nbuf >= 20 then flush() end
end

local function load(name) return assert(loadScript(base .. name .. ".lua"))() end

local function respawn()
  model.reset(s, course.start[1], course.start[2], 0, course.start[3])
  cs = course.new(settings.laps)
  armed = false
  crashAt = 0
end

-- Boot is staged and the heap is collected between modules: compiling a
-- module needs more memory than the module keeps, and an ELRS model leaves a
-- script far less than an empty one ("not enough memory" at load). The last
-- stage reached is written to the log if the boot dies.
local function boot(stage)
  collectgarbage()
  local f = io.open("/LOGS/nacosim_boot.txt", "w")
  if f then
    io.write(f, stage .. string.format(" mem=%dk\n", math.floor(collectgarbage("count"))))
    io.close(f)
  end
end

local function init()
  boot("model")
  model = load("model")
  boot("course")
  course = load("course")
  boot("view")
  view = load("view")
  boot("settings")
  settings = load("settings")
  boot("setup")
  D = view.display
  settings.setDisplay(D)
  course.scan()
  settings.load(course)
  settings.apply(model)
  view.setTilt(settings.tilt)
  course.select(settings.map)
  collectgarbage()
  s = model.new(0, 0, 0, 0)
  respawn()
  local f = io.open(LOG, "w")
  if f then io.write(f, "# NacoSim " .. settings.APP .. " settings v" .. settings.FORMAT .. " map " .. course.current .. " (" .. #course.gates .. ")" .. ((course.loadNote or settings.loadNote) and (" NOTE " .. tostring(course.loadNote or settings.loadNote)) or "") .. "\n"); io.write(f, "t,ail,ele,rud,thr,x,y,z,vx,vy,vz,bx_z,bz_z,w1,w2,w3,armed,memk,note\n"); io.close(f) end
  lastTick = getTime()
  hint = 60
end

local function runInner(event)
  local EXIT = EVT_VIRTUAL_EXIT or EVT_EXIT_BREAK
  local ENTER = EVT_VIRTUAL_ENTER or EVT_ENTER_BREAK
  local OPEN = { EVT_VIRTUAL_MENU, EVT_VIRTUAL_NEXT_PAGE, EVT_VIRTUAL_PREV_PAGE, EVT_TOUCH_TAP }
  local t1 = getTime()
  fpsN = fpsN + 1
  if t1 - fpsT >= 100 then
    fps = fpsN * 100 / (t1 - fpsT); fpsN = 0; fpsT = t1
    settings.setStats(fps, frameMs)
  end
  if menu then
    -- paused: the quad does not move while settings are open
    lastTick, acc = t1, 0
    if settings.event(event, model, course) then
      menu = false
      settings.save()
      view.setTilt(settings.tilt)
      if course.current ~= settings.map then course.select(settings.map); respawn() end
    else
      settings.draw(model, course)
    end
    return 0
  end
  if event == EXIT then flush(); return 1 end
  for i = 1, 4 do
    if OPEN[i] and event == OPEN[i] then menu = true; settings.open(); return 0 end
  end
  if event == ENTER then respawn() end
  local ail = getValue('ail') / 1024 * flip.ail
  local ele = getValue('ele') / 1024 * flip.ele
  local rud = getValue('rud') / 1024 * flip.rud
  local thr = (getValue('thr') + 1024) / 2048
  if not armed and thr < 0.05 then armed = true end
  -- fixed 20 ms steps from the 10 ms tick, at most 4 per call so a slow
  -- frame cannot snowball. Fewer steps per frame is what keeps a frame under
  -- the radio's Lua instruction budget.
  acc = acc + (t1 - lastTick)
  lastTick = t1
  local n = 0
  while acc >= 2 and n < 4 do
    model.step(s, 0.02, ail, ele, rud, thr, armed)
    local laps0 = cs.laps
    if course.update(cs, s.x, s.y, s.z, s.t) and playTone and settings.sound then
      if cs.finished then playTone(2200, 500, 0, PLAY_NOW)
      elseif cs.laps > laps0 then playTone(2200, 220, 0, PLAY_NOW)
      else playTone(1500, 90, 0, PLAY_NOW) end
    end
    if cs.finished then break end
    acc = acc - 2
    n = n + 1
  end
  if acc > 4 then acc = 4 end
  if cs.finished then
    view.finish(course, cs)
    return 0
  end
  logRow(s.t, ail, ele, rud, thr, nil)
  local msg
  if s.crashed then
    msg = s.why or "CRASH"
    if crashAt == 0 then
      crashAt = t1
      logRow(s.t, ail, ele, rud, thr, "CRASH " .. (s.why or ""))
      flush() -- the crash must survive a power-off
    end
    if t1 - crashAt > 250 then respawn() end
  elseif not armed then
    msg = "THR DOWN"
  end
  view.draw(s, course, cs, { msg = msg, ms = showMs and frameMs or nil })
  if hint > 0 then
    hint = hint - 1
    D.text(D.W / 2, 1 + D.lh * 2, "NacoSim  MENU: settings", D.small + CENTER)
  end
  frameMs = (getTime() - t1) * 10
  return 0
end

-- Any error (or the radio killing the script) is written to the log first, so
-- a silent stop leaves a reason behind.
local function run(event)
  local ok, res = pcall(runInner, event)
  if ok then return res end
  local f = io.open(LOG, "a")
  if f then io.write(f, "ERROR " .. tostring(res) .. "\n"); io.close(f) end
  flush()
  lcd.clear()
  lcd.drawText(2, 2, "NacoSim error", 0)
  lcd.drawText(2, 2 + (D and D.lh * 2 or 16), tostring(res), SMLSIZE)
  return 2
end

-- peek is for the desktop tests
return { init = init, run = run, peek = function() return s, cs, course, model end }
