-- Milestone 1: what can this radio run? Draws a spinning wireframe with N
-- projected points per frame, shows fps / CPU / heap, and logs the same to
-- /LOGS/fpvprobe.txt every 2 s so it can be read over USB storage.
-- Left/right trim-free controls: ROLL stick right = more points, left = fewer.
local N = 40
local rampT = 0
local ang = 0
local frames, t0, lastLog = 0, 0, 0
local fps, load = 0, 0

local function fmtLog(s)
  local f = io.open("/LOGS/fpvprobe.txt", "a")
  if f then io.write(f, s, "\n"); io.close(f) end
end

local function init()
  local ver, radio, maj, minr, rev = getVersion()
  t0 = getTime(); lastLog = t0; rampT = t0
  fmtLog(string.format("start ver=%s radio=%s LCD=%dx%d", tostring(ver), tostring(radio), LCD_W, LCD_H))
end

local function run(event)
  if event == EVT_EXIT_BREAK or event == EVT_VIRTUAL_EXIT then return 1 end
  -- auto ramp: +10 points every 2 s up to 600, so the limit shows up in the log
  if getTime() - rampT >= 200 and N < 600 then N = N + 10; rampT = getTime() end
  ang = ang + 0.05
  local c, s = math.cos(ang), math.sin(ang)
  lcd.clear()
  -- N projected points: rotate about y, perspective divide, plot as lines
  local px, py
  for i = 1, N do
    local a = i * 6.2831 / N
    local x, z = math.cos(a) * 20, math.sin(a) * 20
    local xr, zr = x * c - z * s, x * s + z * c + 60
    local u = LCD_W / 2 + xr * 60 / zr * 2
    local v = LCD_H / 2 + 10 * 60 / zr
    if px then lcd.drawLine(px, py, u, v, SOLID, FORCE) end
    px, py = u, v
  end
  lcd.drawRectangle(2, 2, LCD_W - 4, LCD_H - 4)
  frames = frames + 1
  local now = getTime()
  if now - t0 >= 100 then
    fps = frames * 100 / (now - t0); frames = 0; t0 = now
    load = getUsage()
  end
  lcd.drawText(4, 4, string.format("N%d %.1ffps", N, fps), SMLSIZE)
  lcd.drawText(4, 12, string.format("cpu%d%% mem%dk", load, collectgarbage("count")), SMLSIZE)
  lcd.drawText(4, 20, string.format("thr%d ele%d", getValue('thr'), getValue('ele')), SMLSIZE)
  if now - lastLog >= 200 then
    lastLog = now
    fmtLog(string.format("N=%d fps=%.1f cpu=%d%% mem=%dk", N, fps, load, collectgarbage("count")))
  end
  return 0
end

return { init = init, run = run }
