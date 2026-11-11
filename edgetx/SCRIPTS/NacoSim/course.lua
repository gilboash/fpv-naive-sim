-- A short race course and its timer. Gates: centre, compass heading of the
-- direction of flight (0 = north), half width, half height.
local C = {}
local sin, cos, abs = math.sin, math.cos, math.abs
local D2R = 0.017453292

-- Maps: name and gates. Add more here; the settings menu lists them.
C.maps = {
  { name = "Oval", gates = {
    { 0, 30, 2, 0 },
    { 15, 55, 2, 45 },
    { 40, 65, 2, 90 },
    { 65, 55, 2, 135 },
    { 70, 30, 2, 180 },
    { 50, 10, 2, 235 },
    { 20, 5, 2, 280 },
    { -10, 15, 2, 340 },
  } },
}
C.hw, C.hh = 2.0, 1.5

-- per-gate normal (direction of flight) and across vectors, precomputed
for m = 1, #C.maps do
  local gates = C.maps[m].gates
  for i = 1, #gates do
    local g = gates[i]
    local h = g[4] * D2R
    g.nx, g.ny = sin(h), cos(h)
    g.ax, g.ay = cos(h), -sin(h)
  end
end

-- make map i the current one (C.gates is what everything else reads)
function C.select(i)
  if i < 1 or i > #C.maps then i = 1 end
  C.index = i
  C.gates = C.maps[i].gates
end
C.select(1)

-- A race is raceLaps laps timed from the first pass of gate 1 (the hole shot)
-- to the pass of gate 1 that completes the last lap.
function C.new(raceLaps)
  return { nxt = 1, laps = 0, raceLaps = raceLaps or 3, started = false, finished = false,
    t0 = 0, lapT0 = 0, lapTimes = {}, last = 0, best = 0, total = 0, passed = 0,
    px = 0, py = 0, pz = 0, has = false }
end

-- seconds -> "52.3" or "1:05.3"
function C.fmt(t)
  if t >= 60 then return string.format("%d:%04.1f", math.floor(t / 60), t % 60) end
  return string.format("%.1f", t)
end

-- Call every step with the quad position and the time. Returns true when a
-- gate was passed this step.
function C.update(c, x, y, z, now)
  if c.finished then return false end
  local hit = false
  if c.has then
    local g = C.gates[c.nxt]
    local s0 = (c.px - g[1]) * g.nx + (c.py - g[2]) * g.ny
    local s1 = (x - g[1]) * g.nx + (y - g[2]) * g.ny
    if s0 < 0 and s1 >= 0 then
      local f = s0 / (s0 - s1)
      local cx, cy, cz = c.px + (x - c.px) * f, c.py + (y - c.py) * f, c.pz + (z - c.pz) * f
      local across = (cx - g[1]) * g.ax + (cy - g[2]) * g.ay
      if abs(across) <= C.hw and abs(cz - g[3]) <= C.hh then
        hit = true
        c.passed = c.passed + 1
        if c.nxt == 1 then
          if c.started then
            local lap = now - c.lapT0
            c.laps = c.laps + 1
            c.lapTimes[c.laps] = lap
            c.last = lap
            if c.best == 0 or lap < c.best then c.best = lap end
            if c.laps >= c.raceLaps then
              c.finished = true
              c.total = now - c.t0
            end
          else
            c.started = true
            c.t0 = now
          end
          c.lapT0 = now
        end
        c.nxt = c.nxt % #C.gates + 1
      end
    end
  end
  c.px, c.py, c.pz, c.has = x, y, z, true
  return hit
end

return C
