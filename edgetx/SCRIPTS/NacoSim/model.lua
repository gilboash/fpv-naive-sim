-- Rate-mode quad: point mass + orientation. Pure Lua, no radio API, so the
-- desktop harness runs the same file. World: x east, y north, z up.
-- Body: bx forward, by left, bz up (right-handed). Stored in s.r[1..9] as
-- bx = r1..r3, by = r4..r6, bz = r7..r9.
-- Pitch convention as in the rest of this repo: forward stick = nose DOWN =
-- positive rotation about the left axis.
local M = {}
local sqrt, exp, cos, sin, abs = math.sqrt, math.exp, math.cos, math.sin, math.abs
local G = 9.81

-- Betaflight rates per axis (roll, pitch, yaw): Gilboa's Velocidrone quad.
M.cfg = {
  rcRate = { 1.05, 0.90, 0.90 },
  super  = { 0.59, 0.59, 0.58 },
  expo   = { 0.01, 0.01, 0.10 },
  twr = 8.0,        -- thrust / weight at full stick, thrust ~ stick^2
  tau = 0.020,      -- rate response lag, s
  k1 = 0.05, k2 = 0.012, -- linear and quadratic drag
}

-- stick (-1..1) -> deg/s, Betaflight curve (src/flight/rates.ts applyBetaflight)
function M.rate(axis, cmd)
  local c = M.cfg
  local a = abs(cmd)
  local v = cmd
  local e = c.expo[axis]
  if e ~= 0 then v = v * a * a * a * e + v * (1 - e) end
  local f = 1 - a * c.super[axis]
  if f < 0.01 then f = 0.01 end
  return 200 * c.rcRate[axis] * v / f
end

function M.reset(s, x, y, z, headingDeg)
  local h = (headingDeg or 0) * 0.017453292
  s.x, s.y, s.z = x, y, z
  s.vx, s.vy, s.vz = 0, 0, 0
  s.r = s.r or {}
  local r = s.r
  r[1], r[2], r[3] = sin(h), cos(h), 0          -- forward
  r[4], r[5], r[6] = -cos(h), sin(h), 0         -- left
  r[7], r[8], r[9] = 0, 0, 1                    -- up
  s.w1, s.w2, s.w3 = 0, 0, 0
  s.crashed = false
  s.why = nil
  s.speed = 0
  s.t = 0
  return s
end

function M.new(x, y, z, headingDeg)
  return M.reset({}, x or 0, y or 0, z or 0, headingDeg)
end

local function rot(r, i, kx, ky, kz, ct, st)
  local vx, vy, vz = r[i], r[i + 1], r[i + 2]
  local d = (kx * vx + ky * vy + kz * vz) * (1 - ct)
  r[i]     = vx * ct + (ky * vz - kz * vy) * st + kx * d
  r[i + 1] = vy * ct + (kz * vx - kx * vz) * st + ky * d
  r[i + 2] = vz * ct + (kx * vy - ky * vx) * st + kz * d
end

local function orthonormalise(r)
  local n = sqrt(r[1] * r[1] + r[2] * r[2] + r[3] * r[3])
  r[1], r[2], r[3] = r[1] / n, r[2] / n, r[3] / n
  local d = r[4] * r[1] + r[5] * r[2] + r[6] * r[3]
  r[4], r[5], r[6] = r[4] - d * r[1], r[5] - d * r[2], r[6] - d * r[3]
  n = sqrt(r[4] * r[4] + r[5] * r[5] + r[6] * r[6])
  r[4], r[5], r[6] = r[4] / n, r[5] / n, r[6] / n
  r[7] = r[2] * r[6] - r[3] * r[5]
  r[8] = r[3] * r[4] - r[1] * r[6]
  r[9] = r[1] * r[5] - r[2] * r[4]
end

-- One step. ail/ele/rud in -1..1 (right / forward / right positive), thr 0..1.
-- armed=false: no thrust. Returns nothing; reads s.crashed, s.speed.
function M.step(s, dt, ail, ele, rud, thr, armed)
  local c = M.cfg
  local r = s.r
  if s.crashed then return end
  local onGround = s.z <= 0.001
  -- rate response
  local al = 1 - exp(-dt / c.tau)
  local d2r = 0.017453292
  s.w1 = s.w1 + (M.rate(1, ail) * d2r - s.w1) * al
  s.w2 = s.w2 + (M.rate(2, ele) * d2r - s.w2) * al
  s.w3 = s.w3 + (-M.rate(3, rud) * d2r - s.w3) * al
  local t = armed and thr or 0
  if onGround and t < 0.2 then
    -- resting on the grass: level, keep heading, no rotation
    local hx, hy = r[1], r[2]
    local n = sqrt(hx * hx + hy * hy)
    if n < 1e-3 then hx, hy, n = -r[7], -r[8], sqrt(r[7] * r[7] + r[8] * r[8]) end
    hx, hy = hx / n, hy / n
    r[1], r[2], r[3] = hx, hy, 0
    r[4], r[5], r[6] = -hy, hx, 0
    r[7], r[8], r[9] = 0, 0, 1
    s.w1, s.w2, s.w3 = 0, 0, 0
  else
    -- world angular velocity, rotate the frame about it
    local ox = r[1] * s.w1 + r[4] * s.w2 + r[7] * s.w3
    local oy = r[2] * s.w1 + r[5] * s.w2 + r[8] * s.w3
    local oz = r[3] * s.w1 + r[6] * s.w2 + r[9] * s.w3
    local om = sqrt(ox * ox + oy * oy + oz * oz)
    if om > 1e-6 then
      local th = om * dt
      local ct, st = cos(th), sin(th)
      local kx, ky, kz = ox / om, oy / om, oz / om
      rot(r, 1, kx, ky, kz, ct, st)
      rot(r, 4, kx, ky, kz, ct, st)
      rot(r, 7, kx, ky, kz, ct, st)
      orthonormalise(r)
    end
  end
  -- translation
  local a = c.twr * G * t * t
  local v = sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz)
  local drag = c.k1 + c.k2 * v
  local ax = r[7] * a - drag * s.vx
  local ay = r[8] * a - drag * s.vy
  local az = r[9] * a - G - drag * s.vz
  s.vx, s.vy, s.vz = s.vx + ax * dt, s.vy + ay * dt, s.vz + az * dt
  s.x, s.y, s.z = s.x + s.vx * dt, s.y + s.vy * dt, s.z + s.vz * dt
  if s.z < 0 then
    local imp = -s.vz
    -- a quad survives a firm landing or a skim; it does not survive a hard
    -- hit, or touching down upside down at any real speed
    if imp > 10 then
      s.crashed, s.why = true, "HIT " .. math.floor(imp) .. "m/s"
    elseif imp > 4 and r[9] < 0.3 then
      s.crashed, s.why = true, "TUMBLE"
    elseif r[9] < 0 and imp > 1.5 then
      s.crashed, s.why = true, "UPSIDE DOWN"
    end
    s.z = 0
    if s.vz < 0 then s.vz = 0 end
    local f = exp(-dt * 6)
    s.vx, s.vy = s.vx * f, s.vy * f
  end
  s.speed = sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz)
  s.t = s.t + dt
end

return M
