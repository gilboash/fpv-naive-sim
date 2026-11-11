-- First-person wireframe. Size, fonts and colours come from display.lua, so
-- the same drawing code runs on a 128x64 monochrome LCD and on colour screens.
-- No allocation in the frame beyond a few locals.
local D = assert(loadScript("/SCRIPTS/NacoSim/display.lua"))()
local V = {}
local sin, cos, floor = math.sin, math.cos, math.floor
local W, H = D.W, D.H
local F = D.F
local TILT = 25 * 0.017453292     -- camera up-tilt, set from the settings
local NEAR = 0.5
local ct, st = cos(TILT), sin(TILT)
local fx, fy, fz, ux, uy, uz, rx, ry, rz -- camera basis in world
local cx, cy, cz
V.display = D

function V.setTilt(deg)
  TILT = deg * 0.017453292
  ct, st = cos(TILT), sin(TILT)
end

function V.camera(s)
  local r = s.r
  -- forward = bx*cos + bz*sin ; up = -bx*sin + bz*cos ; right = -by
  fx, fy, fz = r[1] * ct + r[7] * st, r[2] * ct + r[8] * st, r[3] * ct + r[9] * st
  ux, uy, uz = -r[1] * st + r[7] * ct, -r[2] * st + r[8] * ct, -r[3] * st + r[9] * ct
  rx, ry, rz = -r[4], -r[5], -r[6]
  cx, cy, cz = s.x, s.y, s.z + 0.1
end

-- world point -> camera (x right, y up, z forward)
local function toCam(x, y, z)
  local dx, dy, dz = x - cx, y - cy, z - cz
  return dx * rx + dy * ry + dz * rz, dx * ux + dy * uy + dz * uz, dx * fx + dy * fy + dz * fz
end

-- Every line is clipped to the screen here before it reaches the LCD: at
-- steep roll/pitch the horizon and ground lines have endpoints thousands of
-- pixels out, and handing those to the radio's drawing code ended the script.
local function draw(x1, y1, x2, y2, pat, role)
  if x1 ~= x1 or y1 ~= y1 or x2 ~= x2 or y2 ~= y2 then return end
  local xmax, ymax = W - 1, H - 1
  if (x1 < 0 and x2 < 0) or (x1 > xmax and x2 > xmax) or (y1 < 0 and y2 < 0) or (y1 > ymax and y2 > ymax) then return end
  if x1 < 0 or x1 > xmax or y1 < 0 or y1 > ymax or x2 < 0 or x2 > xmax or y2 < 0 or y2 > ymax then
    -- Liang-Barsky against [0,xmax] x [0,ymax]
    local dx, dy = x2 - x1, y2 - y1
    local t0, t1 = 0, 1
    local p = { -dx, dx, -dy, dy }
    local q = { x1, xmax - x1, y1, ymax - y1 }
    for i = 1, 4 do
      if p[i] == 0 then
        if q[i] < 0 then return end
      else
        local r = q[i] / p[i]
        if p[i] < 0 then
          if r > t1 then return end
          if r > t0 then t0 = r end
        else
          if r < t0 then return end
          if r < t1 then t1 = r end
        end
      end
    end
    x1, y1, x2, y2 = x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy
  end
  D.line(floor(x1 + 0.5), floor(y1 + 0.5), floor(x2 + 0.5), floor(y2 + 0.5), pat, role)
end

local function seg(x1, y1, z1, x2, y2, z2, pat, role)
  -- clip to the near plane in camera space
  if z1 < NEAR and z2 < NEAR then return end
  if z1 < NEAR then
    local f = (NEAR - z1) / (z2 - z1)
    x1, y1, z1 = x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, NEAR
  elseif z2 < NEAR then
    local f = (NEAR - z2) / (z1 - z2)
    x2, y2, z2 = x2 + (x1 - x2) * f, y2 + (y1 - y2) * f, NEAR
  end
  draw(W / 2 + x1 / z1 * F, H / 2 - y1 / z1 * F, W / 2 + x2 / z2 * F, H / 2 - y2 / z2 * F, pat, role)
end

local function line3(ax, ay, az, bx, by, bz, pat, role)
  local x1, y1, z1 = toCam(ax, ay, az)
  local x2, y2, z2 = toCam(bx, by, bz)
  seg(x1, y1, z1, x2, y2, z2, pat, role)
end

local function horizon()
  -- world up in camera coords is (rz, uz, fz); horizon: rz*x + uz*y + fz*F = 0
  local a, b, c = rz, uz, fz * F
  if b > 1e-3 or b < -1e-3 then
    local xl, xr = -W / 2, W / 2
    draw(W / 2 + xl, H / 2 + (a * xl + c) / b, W / 2 + xr, H / 2 + (a * xr + c) / b, SOLID, "horizon")
  elseif a > 1e-3 or a < -1e-3 then
    local x = -c / a
    draw(W / 2 + x, 0, W / 2 + x, H - 1, SOLID, "horizon")
  end
end

local function grid(s)
  local step = 25
  local gx, gy = floor(s.x / step) * step, floor(s.y / step) * step
  local n = D.grid
  for i = -n, n do
    line3(gx + i * step, gy - (n + 1) * step, 0, gx + i * step, gy + (n + 1) * step, 0, DOTTED, "grid")
    line3(gx - (n + 1) * step, gy + i * step, 0, gx + (n + 1) * step, gy + i * step, 0, DOTTED, "grid")
  end
end

-- four corners projected once, four segments; the next gate gets a second
-- outline so it reads as the target
local function gate(g, hw, hh, thick)
  local ax, ay = g.ax * hw, g.ay * hw
  local z0, z1 = g[3] - hh, g[3] + hh
  local x1, y1, w1 = toCam(g[1] - ax, g[2] - ay, z0)
  local x2, y2, w2 = toCam(g[1] + ax, g[2] + ay, z0)
  local x3, y3, w3 = toCam(g[1] + ax, g[2] + ay, z1)
  local x4, y4, w4 = toCam(g[1] - ax, g[2] - ay, z1)
  local role = thick and "next" or "gate"
  seg(x1, y1, w1, x2, y2, w2, SOLID, role)
  seg(x2, y2, w2, x3, y3, w3, SOLID, role)
  seg(x3, y3, w3, x4, y4, w4, SOLID, role)
  seg(x4, y4, w4, x1, y1, w1, SOLID, role)
  if thick then
    seg(x1 - 1, y1, w1, x4 - 1, y4, w4, SOLID, role)
    seg(x2 + 1, y2, w2, x3 + 1, y3, w3, SOLID, role)
    if D.thick then   -- colour screens: a second outline all round
      seg(x1, y1 - 1, w1, x2, y2 - 1, w2, SOLID, role)
      seg(x3, y3 + 1, w3, x4, y4 + 1, w4, SOLID, role)
    end
  end
end

-- Where the next gate is: a diamond on its centre when it is in view, an
-- arrow at the screen edge pointing to it when it is off to the side or behind.
local function marker(g)
  local x, y, z = toCam(g[1], g[2], g[3])
  local m = D.lh * 0.7                     -- marker size scales with the text
  if z > NEAR then
    local sx, sy = W / 2 + x / z * F, H / 2 - y / z * F
    if sx > m + 2 and sx < W - m - 3 and sy > m + 2 and sy < H - m - 3 then
      draw(sx - m, sy, sx, sy - m, SOLID, "next")
      draw(sx, sy - m, sx + m, sy, SOLID, "next")
      draw(sx + m, sy, sx, sy + m, SOLID, "next")
      draw(sx, sy + m, sx - m, sy, SOLID, "next")
      return
    end
  end
  -- direction on screen (y flips: camera up is screen up)
  local dx, dy = x, -y
  local n = math.sqrt(dx * dx + dy * dy)
  if n < 1e-3 then dx, dy, n = 0, 1, 1 end
  dx, dy = dx / n, dy / n
  local inset = m * 1.8
  local tx = dx ~= 0 and (W / 2 - inset) / math.abs(dx) or 1e9
  local ty = dy ~= 0 and (H / 2 - inset) / math.abs(dy) or 1e9
  local t = tx < ty and tx or ty
  local px, py = W / 2 + dx * t, H / 2 + dy * t     -- tip
  local bx, by = px - dx * m * 1.8, py - dy * m * 1.8   -- base centre
  local nx, ny = -dy * m, dx * m
  draw(px, py, bx + nx, by + ny, SOLID, "next")
  draw(px, py, bx - nx, by - ny, SOLID, "next")
  draw(bx + nx, by + ny, bx - nx, by - ny, SOLID, "next")
end

-- s: model state, course: course module, cs: course state, info: table of
-- strings/flags from the tool (msg, ms)
function V.draw(s, course, cs, info)
  D.clear()
  V.camera(s)
  horizon()
  grid(s)
  local n = #course.gates
  for i = 1, n do
    -- the next gate and a few after it: every line costs instructions
    local d = (i - cs.nxt) % n
    if d <= D.gatesAhead then gate(course.gates[i], course.hw, course.hh, d == 0) end
  end
  marker(course.gates[cs.nxt])
  -- HUD: trademark and speed top left, race clock top right, height bottom
  -- left, gate bottom centre, last lap bottom right
  local lh, S = D.lh, D.small
  local bot = H - lh
  D.text(1, 1, "NacoSim", S)
  D.text(1, 1 + lh, string.format("%d", floor(s.speed * 3.6 + 0.5)), S)
  D.text(1, bot, string.format("%dm", floor(s.z + 0.5)), S)
  local clock = (cs.started and not cs.finished) and (s.t - cs.t0) or 0
  D.text(W - 1, 1, course.fmt(clock), S + RIGHT)
  D.text(W / 2, bot, string.format("g%d/%d", cs.nxt, n), S + CENTER)
  if cs.laps > 0 then
    D.text(W - 1, bot, string.format("L%d %s", cs.laps, course.fmt(cs.last)), S + RIGHT)
  else
    D.text(W - 1, bot, string.format("LAP 1/%d", cs.raceLaps), S + RIGHT)
  end
  if info.msg then D.text(W / 2, H / 2 - lh, info.msg, D.mid + CENTER, "msg") end
  if info.ms then D.text(W / 2, bot - lh, string.format("%dms", info.ms), S + CENTER) end
end

-- End-of-race screen: total, then each lap
function V.finish(course, cs)
  D.clear()
  local lh, S = D.lh, D.small
  D.text(2, 1, "NacoSim FINISH", S)
  D.text(W - 2, 1, course.fmt(cs.total), S + RIGHT)
  D.line(0, D.hh, W - 1, D.hh, SOLID, "horizon")
  local n = cs.laps
  local room = floor((H - D.hh - lh * 2) / (lh + 1))   -- lap rows that fit
  if room < 1 then room = 1 end
  local first = n > room and n - room + 1 or 1         -- long races: the last ones
  local y = D.hh + 3
  for i = first, n do
    local t = cs.lapTimes[i]
    D.text(4, y, string.format("Lap %d", i), S)
    D.text(W * 0.55, y, course.fmt(t), S + RIGHT)
    if t == cs.best then D.text(W * 0.58, y, "best", S, "next") end
    y = y + lh + 1
  end
  D.text(W / 2, H - lh, "ENTER: again", S + CENTER)
end

return V
