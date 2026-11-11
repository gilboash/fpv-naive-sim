-- NacoSim settings: sound, map, rates. Saved on the radio. The menu draws and
-- handles keys itself; the tool only decides when it is open.
local S = {}
local D            -- display profile, set by the tool via S.setDisplay
local stats = { fps = 0, ms = 0 }
local floor, abs = math.floor, math.abs
local FILE = "/SCRIPTS/NacoSim/settings.txt"

S.sound = true
S.map = 1
S.preset = 1
S.laps = 3
S.tilt = 25
local LAPS = { 1, 3, 5, 10 }
-- roll, pitch, yaw: rcRate, super, expo
S.rates = { 1.05, 0.59, 0.01, 0.90, 0.59, 0.01, 0.90, 0.58, 0.10 }
S.presets = {
  { "Quad",   { 1.05, 0.59, 0.01, 0.90, 0.59, 0.01, 0.90, 0.58, 0.10 } },
  { "BF def", { 1.00, 0.70, 0.00, 1.00, 0.70, 0.00, 1.00, 0.70, 0.00 } },
  { "Soft",   { 0.70, 0.40, 0.20, 0.70, 0.40, 0.20, 0.60, 0.40, 0.20 } },
}

local screen, cur, editing = 1, 1, false -- 1 main, 2 rates grid, 3 info
local ITEMS = 8

local function clamp(v, lo, hi) if v < lo then return lo elseif v > hi then return hi end return v end

function S.apply(M)
  for a = 1, 3 do
    M.cfg.rcRate[a] = S.rates[(a - 1) * 3 + 1]
    M.cfg.super[a] = S.rates[(a - 1) * 3 + 2]
    M.cfg.expo[a] = S.rates[(a - 1) * 3 + 3]
  end
end

-- Settings file format. Versions 1-3 had no tag and are told apart by how many
-- numbers they hold; from 4 on the first field is "v<N>". A file from a newer
-- NacoSim is ignored rather than misread; an older one is migrated step by
-- step. Layout (v4): sound, map, preset, 9 rates, laps, tilt.
S.APP = "0.5.0"      -- NacoSim version, shown in Info and written to the logs
S.FORMAT = 4
local NVALUES = 14

function S.save()
  local f = io.open(FILE, "w")
  if not f then return false end
  -- no `table` library on the radio: build the line by concatenation
  local line = "v" .. S.FORMAT .. "," .. (S.sound and 1 or 0) .. "," .. S.map .. "," .. S.preset
  for i = 1, 9 do line = line .. "," .. string.format("%.2f", S.rates[i]) end
  line = line .. "," .. S.laps .. "," .. S.tilt .. "\n"
  io.write(f, line)
  io.close(f)
  return true
end

-- v: parsed numbers, ver: the version they were written in. Brings them to
-- the current layout, one version at a time.
local function migrate(v, ver)
  if ver == 1 then v[13] = 3; ver = 2 end     -- Laps arrived in 2
  if ver == 2 then v[14] = 25; ver = 3 end    -- Tilt arrived in 3
  if ver == 3 then ver = 4 end                -- 4 only added the version tag
  return v, ver
end

-- returns true if a file was read; false leaves the defaults in place
function S.load(C)
  S.loadNote = nil
  local f = io.open(FILE, "r")
  if not f then return false end
  local txt = io.read(f, 200)
  io.close(f)
  if not txt or txt == "" then return false end
  local v, n, ver = {}, 0, nil
  for tok in string.gmatch(txt, "[^,\n]+") do
    if n == 0 and ver == nil and string.sub(tok, 1, 1) == "v" then
      ver = tonumber(string.sub(tok, 2))
      if not ver then return false end
    else
      n = n + 1
      v[n] = tonumber(tok)
      if not v[n] then return false end
    end
  end
  if not ver then
    ver = (n == 12 and 1) or (n == 13 and 2) or (n == 14 and 3) or nil
    if not ver then return false end
  end
  if ver > S.FORMAT then S.loadNote = "newer settings ignored"; return false end
  v, ver = migrate(v, ver)
  if n < 12 or #v < NVALUES then return false end
  S.sound = v[1] == 1
  S.map = floor(clamp(v[2], 1, C and #C.maps or 1))
  S.preset = floor(clamp(v[3], 0, #S.presets))
  for i = 1, 9 do S.rates[i] = v[3 + i] end
  S.laps = (v[13] >= 1 and v[13] <= 10) and floor(v[13]) or 3
  S.tilt = (v[14] >= 0 and v[14] <= 60) and floor(v[14]) or 25
  return true
end

local function presetName()
  if S.preset >= 1 then
    local p = S.presets[S.preset][2]
    for i = 1, 9 do if abs(p[i] - S.rates[i]) > 0.001 then return "custom" end end
    return S.presets[S.preset][1]
  end
  return "custom"
end

local function ev(name) return _G[name] end

-- Returns true when the menu should close.
function S.event(event, M, C)
  local EXIT, ENTER = ev("EVT_VIRTUAL_EXIT") or ev("EVT_EXIT_BREAK"), ev("EVT_VIRTUAL_ENTER") or ev("EVT_ENTER_BREAK")
  local up = event ~= 0 and (event == ev("EVT_VIRTUAL_PREV") or event == ev("EVT_VIRTUAL_DEC"))
  local down = event ~= 0 and (event == ev("EVT_VIRTUAL_NEXT") or event == ev("EVT_VIRTUAL_INC"))
  local step = down and 1 or (up and -1 or 0)
  if screen == 3 then
    if event == EXIT or event == ENTER then screen, cur = 1, 7 end
    return false
  end
  if screen == 1 then
    if event == EXIT then return true end
    if step ~= 0 then cur = (cur - 1 + step) % ITEMS + 1 end
    if event == ENTER then
      if cur == 1 then S.sound = not S.sound
      elseif cur == 2 then S.map = S.map % #C.maps + 1
      elseif cur == 3 then
        local k = 1
        for i = 1, #LAPS do if LAPS[i] == S.laps then k = i end end
        S.laps = LAPS[k % #LAPS + 1]
      elseif cur == 4 then
        S.tilt = (S.tilt + 5) % 65   -- 0, 5 ... 60, then round to 0
      elseif cur == 5 then
        S.preset = S.preset % #S.presets + 1
        for i = 1, 9 do S.rates[i] = S.presets[S.preset][2][i] end
        S.apply(M)
      elseif cur == 6 then screen, cur, editing = 2, 1, false
      elseif cur == 7 then screen = 3
      else return true end
    end
  else
    if event == EXIT then
      if editing then editing = false else screen, cur = 1, 6 end
    elseif event == ENTER then editing = not editing
    elseif step ~= 0 then
      if editing then
        local col = (cur - 1) % 3 + 1
        local lo, hi = 0, 1
        if col == 1 then lo, hi = 0.01, 2.55 elseif col == 2 then lo, hi = 0, 0.99 end
        S.rates[cur] = clamp(floor((S.rates[cur] + step * 0.01) * 100 + 0.5) / 100, lo, hi)
        S.apply(M)
      else
        cur = (cur - 1 + step) % 9 + 1
      end
    end
  end
  return false
end

local mapName = ""

local function rowText(i)
  if i == 1 then return "Sound   " .. (S.sound and "ON" or "OFF")
  elseif i == 2 then return "Map     " .. mapName
  elseif i == 3 then return "Laps    " .. S.laps
  elseif i == 4 then return "Tilt    " .. S.tilt .. " deg"
  elseif i == 5 then return "Rates   " .. presetName()
  elseif i == 6 then return "Edit rates >"
  elseif i == 7 then return "Info >"
  end
  return "Back"
end

function S.setDisplay(d) D = d end
function S.setStats(fps, ms) stats.fps, stats.ms = fps, ms end

local function info()
  local ver, radio = "?", "?"
  if getVersion then
    local v, r = getVersion()
    ver, radio = tostring(v), tostring(r)
  end
  local mem = collectgarbage and floor(collectgarbage("count")) or 0
  return {
    "NacoSim " .. S.APP .. " (cfg v" .. S.FORMAT .. ")",
    "radio " .. radio .. "  EdgeTX " .. ver,
    string.format("screen %dx%d %s", D.W, D.H, D.colour and "colour" or "mono"),
    string.format("%.0f fps  %d ms/frame", stats.fps, stats.ms),
    string.format("lua mem %dk", mem),
  }
end

function S.draw(M, C)
  D.clear()
  local lh, sm = D.lh, D.small
  mapName = C.maps[S.map].name
  if screen == 1 then
    D.text(2, 1, "NacoSim settings", sm)
    D.line(0, D.hh, D.W - 1, D.hh, SOLID, "horizon")
    -- rows at a time, scrolled to keep the cursor in view
    local nrow = D.rows < ITEMS and D.rows or ITEMS
    local first = cur - floor(nrow / 2)
    if first < 1 then first = 1 elseif first > ITEMS - nrow + 1 then first = ITEMS - nrow + 1 end
    for i = first, first + nrow - 1 do
      D.text(4, D.hh + 3 + (i - first) * D.rowH, rowText(i), sm + (i == cur and INVERS or 0))
    end
    if first > 1 then D.text(D.W - D.cw, D.hh + 2, "^", sm) end
    if first + nrow - 1 < ITEMS then D.text(D.W - D.cw, D.H - lh, "v", sm) end
  elseif screen == 3 then
    D.text(2, 1, "NacoSim info", sm)
    D.line(0, D.hh, D.W - 1, D.hh, SOLID, "horizon")
    local lines = info()
    for i = 1, #lines do D.text(4, D.hh + 3 + (i - 1) * D.rowH, lines[i], sm) end
  else
    local x0, colw = D.cw * 3, floor((D.W - D.cw * 4) / 3)
    D.text(x0, 1, "RATE", sm)
    D.text(x0 + colw, 1, "SUPER", sm)
    D.text(x0 + colw * 2, 1, "EXPO", sm)
    if editing then D.text(D.W - D.cw * 4, D.H - lh, "edit", sm, "next") end
    local names = { "R", "P", "Y" }
    for a = 1, 3 do
      local y = D.hh + 3 + (a - 1) * (D.rowH + 2)
      D.text(1, y, names[a], sm)
      for c = 1, 3 do
        local i = (a - 1) * 3 + c
        local flags = sm
        if i == cur then flags = flags + (editing and (INVERS + BLINK) or INVERS) end
        D.text(x0 + (c - 1) * colw, y, string.format("%.2f", S.rates[i]), flags)
      end
    end
    D.text(2, D.H - lh, string.format("max %d %d %d deg/s", floor(M.rate(1, 1) + 0.5), floor(M.rate(2, 1) + 0.5), floor(M.rate(3, 1) + 0.5)), sm)
  end
end

function S.open() screen, cur, editing = 1, 1, false end

return S
