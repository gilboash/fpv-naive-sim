-- Draws the sim's real screens into standalone SVG files for the download
-- page: the actual view, menu and finish code running against a stub LCD, on a
-- 128x64 monochrome screen and a 480x272 colour one. Only maps that are in
-- the repository are used, so the pictures can be rebuilt from a clean clone.
--   lua edgetx/test/shots.lua [out-dir]        (default public/nacosim)
-- npm run rc:shots does the same. Re-run it whenever the screens change.
local here = arg[0]:match("^(.*)/test/shots.lua$") or "edgetx"
local outDir = arg[1] or (here .. "/../public/nacosim")
os.execute('mkdir -p "' .. outDir .. '"')

local PROFILES = {
  mono = { w = 128, h = 64, colour = false, k = 5 },
  colour = { w = 480, h = 272, colour = true, k = 1.6 },
}

local function esc(s) return (s:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")) end
local function hex(c) return string.format("#%02x%02x%02x", (c // 65536) % 256, (c // 256) % 256, c % 256) end

local EV = { EXIT = 1, ENTER = 2, MENU = 3, NEXT = 4, PREV = 5, INC = 6, DEC = 7 }

-- Renders one frame: `draw` is called with the loaded modules after the stub
-- LCD is installed for profile P; returns the SVG text.
local function render(P, draw)
  for k in pairs(package.loaded) do package.loaded[k] = nil end
  SOLID, DOTTED, FORCE, SMLSIZE, MIDSIZE, RIGHT, CENTER, INVERS, BLINK = 0, 1, 2, 4, 8, 16, 32, 64, 128
  CUSTOM_COLOR = 256
  EVT_VIRTUAL_EXIT, EVT_VIRTUAL_ENTER, EVT_VIRTUAL_MENU, EVT_VIRTUAL_NEXT, EVT_VIRTUAL_PREV, EVT_VIRTUAL_INC, EVT_VIRTUAL_DEC = 1, 2, 3, 4, 5, 6, 7
  LCD_W, LCD_H = P.w, P.h
  local K = P.k
  local cw = P.colour and 8 or 5          -- small text character width, px
  local bg, fg, cur = "#000", "#f2f2f2", "#f2f2f2"
  local body = {}
  local api = {}
  api.clear = function(flag) body = {}; if flag and P.colour then bg = cur end end
  api.drawLine = function(a, b, c, d, pat, flags)
    local col = ((flags or 0) & 256) ~= 0 and cur or fg
    local w = P.colour and 2.2 or (K - 1.2)
    body[#body + 1] = string.format('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.1f" stroke-linecap="square"%s/>',
      a * K + K / 2, b * K + K / 2, c * K + K / 2, d * K + K / 2, col, w, pat == 1 and (' stroke-dasharray="' .. (K * 1.2) .. ' ' .. (K * 3.5) .. '" opacity="0.7"') or "")
  end
  api.drawText = function(x, y, t, flags)
    flags = flags or 0
    local col = (flags & 256) ~= 0 and cur or fg
    local big = (flags & 8) ~= 0
    local charW = cw * (big and 1.6 or 1)
    local len = #t * charW * K
    local lineH = (P.colour and 16 or 8) * (big and 1.6 or 1)
    local anchor, ax = "start", x * K
    if (flags & 16) ~= 0 then anchor = "end" elseif (flags & 32) ~= 0 then anchor = "middle" end
    local inv = (flags & 64) ~= 0
    local left = anchor == "end" and ax - len or (anchor == "middle" and ax - len / 2 or ax)
    if inv then body[#body + 1] = string.format('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s"/>', left - K * 0.5, y * K, len + K, lineH * K - K * 0.5, col) end
    body[#body + 1] = string.format('<text x="%.1f" y="%.1f" fill="%s" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="%.1f" text-anchor="%s" textLength="%.1f" lengthAdjust="spacingAndGlyphs">%s</text>',
      ax, (y + lineH * 0.82) * K, inv and bg or col, lineH * K * 0.86, anchor, len, esc(t))
  end
  api.drawRectangle = function() end
  if P.colour then
    api.RGB = function(r, g, b) return r * 65536 + g * 256 + b end
    api.setColor = function(_, c) cur = hex(c) end
    api.drawFilledRectangle = function() end
  end
  lcd = setmetatable(api, { __index = function(_, key)
    if key == "setColor" or key == "RGB" then return nil end
    error("lcd." .. tostring(key) .. " does not exist in the EdgeTX API", 2)
  end })
  getVersion = function() return "2.10.0", P.colour and "tx16s" or "t14" end
  loadScript = function(p) return loadfile(here .. "/SCRIPTS/NacoSim/" .. p:match("([^/]+)$")) end
  package.path = here .. "/SCRIPTS/NacoSim/?.lua;" .. package.path
  dofile(here .. "/test/stubs.lua").install(here)
  local M, C, V, St = require("model"), require("course"), require("view"), require("settings")
  St.setDisplay(V.display)
  C.scan()
  draw(M, C, V, St)
  local frame = P.colour and 'stroke="#2a323d"' or 'stroke="#333"'
  return string.format('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges"><rect width="100%%" height="100%%" fill="%s"/>%s</svg>\n',
    math.floor(P.w * K), math.floor(P.h * K), bg, table.concat(body))
end

local function save(name, svg)
  local f = assert(io.open(outDir .. "/" .. name .. ".svg", "w"))
  f:write(svg); f:close()
  print("wrote " .. name .. ".svg (" .. #svg .. " bytes)")
end

-- a flying frame: map, checkpoint to aim at, where the quad is
local function fly(spec)
  return function(M, C, V)
    C.select(spec.map)
    local cs = C.new(3)
    cs.nxt = spec.next
    cs.started, cs.laps, cs.last = spec.started ~= false, spec.laps or 0, spec.last or 0
    local s = M.new(0, 0, 0, 0)
    M.reset(s, spec.x, spec.y, spec.z, spec.heading)
    -- flying, not sitting: nose down (pitch) and a little bank, as in a real run
    local r = s.r
    local p, q = math.rad(spec.pitch or 25), math.rad(spec.bank or 0)
    local cp, sp, cq, sq = math.cos(p), math.sin(p), math.cos(q), math.sin(q)
    for i = 0, 2 do
      local bx, bz = r[1 + i], r[7 + i]
      r[1 + i], r[7 + i] = bx * cp - bz * sp, bz * cp + bx * sp
    end
    for i = 0, 2 do
      local by, bz = r[4 + i], r[7 + i]
      r[4 + i], r[7 + i] = by * cq + bz * sq, bz * cq - by * sq
    end
    s.z = spec.z
    s.speed = spec.speed or 0
    s.t = 20
    cs.t0 = s.t - (spec.clock or 0)
    V.setTilt(spec.tilt or 25)
    V.draw(s, C, cs, { msg = spec.msg })
  end
end

local function menu(events, map)
  return function(M, C, V, St)
    St.map = map or "oval"
    St.setStats(20, 11)
    St.open()
    for _, e in ipairs(events) do St.event(e, M, C) end
    St.draw(M, C)
  end
end

local function finish(M, C, V)
  C.select("race-vibes")
  local cs = C.new(3)
  cs.laps, cs.finished, cs.total, cs.best = 3, true, 63.4, 20.1
  cs.lapTimes = { 21.4, 20.1, 21.9 }
  V.finish(C, cs)
end

local SCENES = {
  -- name, profile, drawing
  { "fly-gate", "mono", fly({ map = "oval", next = 1, x = -0.4, y = 20, z = 2.3, heading = 2, bank = -6, speed = 15, clock = 6.2 }) },
  { "fly-gates", "mono", fly({ map = "oval", next = 2, x = 9, y = 41, z = 2.2, heading = 25, bank = 12, speed = 17, clock = 9.8 }) },
  { "wrong-side", "mono", fly({ map = "oval", next = 1, x = 0.4, y = 38.5, z = 2.3, heading = 178, speed = 9, clock = 12.5 }) },
  { "flag", "mono", fly({ map = "race-vibes", next = 2, x = 6.5, y = -14.5, z = 2.6, heading = 6, bank = 8, speed = 12, clock = 3.1 }) },
  { "edge-arrow", "mono", fly({ map = "oval", next = 2, x = 6, y = 40, z = 3, heading = 235, bank = 15, speed = 10, clock = 8.0 }) },
  { "menu", "mono", menu({ EV.NEXT }, "race-vibes") },
  { "rates", "mono", menu({ EV.NEXT, EV.NEXT, EV.NEXT, EV.NEXT, EV.NEXT, EV.ENTER, EV.NEXT, EV.NEXT, EV.NEXT }) },
  { "info", "mono", menu({ EV.NEXT, EV.NEXT, EV.NEXT, EV.NEXT, EV.NEXT, EV.NEXT, EV.ENTER }, "race-vibes") },
  { "finish", "mono", finish },
  { "colour-fly", "colour", fly({ map = "race-vibes", next = 1, x = -0.3, y = -31, z = 2.4, heading = 1, bank = -5, speed = 14, clock = 2.4 }) },
  { "colour-flag", "colour", fly({ map = "race-vibes", next = 2, x = 6.5, y = -14, z = 2.8, heading = 6, bank = 8, speed = 12, clock = 5.0, laps = 1, last = 21.4 }) },
  { "colour-menu", "colour", menu({ EV.NEXT }, "race-vibes") },
  { "colour-finish", "colour", finish },
}

for _, sc in ipairs(SCENES) do
  save(sc[1], render(PROFILES[sc[2]], sc[3]))
end
