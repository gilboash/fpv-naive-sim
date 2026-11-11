-- A short race course and its timer. Gates: centre, compass heading of the
-- direction of flight (0 = north), half width, half height.
local C = {}
local sin, cos, abs = math.sin, math.cos, math.abs
local D2R = 0.017453292

-- A map is a file on the SD card (SCRIPTS/NacoSim/maps/<key>.map), parsed when
-- it is selected. "oval" is built in so there is always something to fly.
-- A checkpoint is { x, y, z, heading, ... }: x east, y north, z up, heading
-- compass degrees of the direction of travel. kind 0 is an upright gate (hw,
-- hh half width and height); kind 1 is a flag (z is the pole height, side +1
-- to pass on the right of the pole, -1 on the left, pw how far out still counts).
C.DIR = "/SCRIPTS/NacoSim/maps"
C.MAX = 80                        -- checkpoints per map: memory and frame cost
C.keys = { "oval" }
C.loadNote = nil

-- Gates are drawn and timed this much bigger than the map says (maps keep the
-- real size). One number for both, so what you see is what counts.
C.GATE_SCALE = 1.25

-- Flags are forgiving: you do not have to be close to the pole, and clipping
-- the wrong side of it by a metre still counts (the pole has thickness and so
-- has a quad). The map's pass width is multiplied by FLAG_SCALE, and the line
-- through the pole is crossed with FLAG_GRACE metres to spare on the wrong side.
C.FLAG_SCALE = 2.0
C.FLAG_GRACE = 1.0

local function prep(g)
  if g.kind == 0 then
    g.hw, g.hh = g.hw * C.GATE_SCALE, g.hh * C.GATE_SCALE
    if g[3] - g.hh < 0 then g[3] = g.hh end   -- the bottom bar rests on the grass, not under it
  end
  if g.kind == 1 then g.pw = g.pw * C.FLAG_SCALE end
  local h = g[4] * D2R
  g.nx, g.ny = sin(h), cos(h)     -- direction of travel
  g.ax, g.ay = cos(h), -sin(h)    -- to the right of it
  g.mz = g.kind == 1 and g[3] * 0.6 or g[3]   -- where the marker points
  return g
end

local function gate(x, y, z, h, hw, hh) return prep({ x, y, z, h, kind = 0, hw = hw, hh = hh }) end

local OVAL = { key = "oval", title = "Oval", start = { 0, 0, 0 }, gates = {
  gate(0, 30, 2, 0, 2, 1.5),
  gate(15, 55, 2, 45, 2, 1.5),
  gate(40, 65, 2, 90, 2, 1.5),
  gate(65, 55, 2, 135, 2, 1.5),
  gate(70, 30, 2, 180, 2, 1.5),
  gate(50, 10, 2, 235, 2, 1.5),
  gate(20, 5, 2, 280, 2, 1.5),
  gate(-10, 15, 2, 340, 2, 1.5),
} }

-- Parse a map file's text. Returns the map, or nil and the reason.
function C.parse(text, key)
  local m = { key = key, title = key, start = { 0, 0, 0 }, gates = {} }
  local n, header = 0, false
  for line in string.gmatch(text, "[^\r\n]+") do
    local f, k = {}, 0
    for tok in string.gmatch(line, "%S+") do k = k + 1; f[k] = tok end
    local op = f[1]
    if op and string.sub(op, 1, 1) ~= "#" then
      if not header then
        if op ~= "nacosim-map" then return nil, "not a NacoSim map" end
        if (tonumber(f[2]) or 0) > 1 then return nil, "map is from a newer NacoSim" end
        header = true
      elseif op == "name" then
        m.title = string.sub(line, 6)
      elseif op == "start" then
        local x, y, h = tonumber(f[2]), tonumber(f[3]), tonumber(f[4])
        if not (x and y and h) then return nil, "bad start line" end
        m.start = { x, y, h }
      elseif op == "g" or op == "f" then
        local x, y, z, h, p5, p6 = tonumber(f[2]), tonumber(f[3]), tonumber(f[4]), tonumber(f[5]), tonumber(f[6]), tonumber(f[7])
        if not (x and y and z and h and p5 and p6) then return nil, "bad " .. op .. " line" end
        if n >= C.MAX then return nil, "too many checkpoints" end
        n = n + 1
        if op == "g" then
          m.gates[n] = prep({ x, y, z, h, kind = 0, hw = p5, hh = p6 })
        else
          if p5 ~= 1 and p5 ~= -1 then return nil, "flag side must be 1 or -1" end
          m.gates[n] = prep({ x, y, z, h, kind = 1, side = p5, pw = p6 })
        end
      end
    end
  end
  if not header then return nil, "empty map" end
  if n < 1 then return nil, "map has no gates" end
  return m
end

local function readAll(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local txt = ""
  while true do
    local chunk = io.read(f, 512)
    if not chunk or chunk == "" then break end
    txt = txt .. chunk
    if #txt > 12000 then break end   -- a map is a few hundred bytes to a few KB
  end
  io.close(f)
  return txt
end

-- Which maps are on the card: "oval" first, then the .map files by name.
function C.scan()
  local found, n = {}, 0
  if dir then
    pcall(function()
      for name in dir(C.DIR) do
        local key = string.match(name, "^([a-z0-9%-]+)%.map$")
        if key then n = n + 1; found[n] = key end
      end
    end)
  end
  for i = 2, n do                 -- insertion sort: no table library on the radio
    local v, j = found[i], i - 1
    while j >= 1 and found[j] > v do found[j + 1] = found[j]; j = j - 1 end
    found[j + 1] = v
  end
  C.keys = { "oval" }
  for i = 1, n do C.keys[i + 1] = found[i] end
  return C.keys
end

-- Display name for a key: the file name with dashes as spaces.
function C.titleOf(key)
  if key == "oval" then return "Oval" end
  return (string.gsub(key, "-", " "))
end

-- Make map `key` the current one (C.gates is what everything else reads). An
-- unreadable map falls back to the oval and says why in C.loadNote.
function C.select(key)
  C.loadNote = nil
  local m
  if key and key ~= "oval" then
    local txt = readAll(C.DIR .. "/" .. key .. ".map")
    if not txt then
      C.loadNote = "map " .. key .. " not found"
    else
      local why
      m, why = C.parse(txt, key)
      if not m then C.loadNote = key .. ": " .. tostring(why) end
    end
  end
  m = m or OVAL
  C.current, C.title, C.start, C.gates = m.key, m.title, m.start, m.gates
  return m
end
C.select("oval")

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
      local ok
      if g.kind == 1 then
        -- a flag: the same plane crossing, on the right side of the pole and
        -- near enough (the web sim's testFlag, made more forgiving: see
        -- FLAG_SCALE and FLAG_GRACE); height does not matter
        ok = across * g.side > -C.FLAG_GRACE and abs(across) <= g.pw
      else
        ok = abs(across) <= g.hw and abs(cz - g[3]) <= g.hh
      end
      if ok then
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
