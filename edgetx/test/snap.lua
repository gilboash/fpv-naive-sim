-- Renders what the radio would show: the real view code drawing into an SVG
-- (white on black, 128x64 scaled up), for looking at a map without a radio.
--   lua edgetx/test/snap.lua out.html map:checkpoint:back[:distance] [...]
-- back = 180 looks at the checkpoint from behind (arrow case).
local here = arg[0]:match("^(.*)/test/snap.lua$") or "edgetx"
SOLID, DOTTED, FORCE, SMLSIZE, MIDSIZE, RIGHT, CENTER, INVERS, BLINK = 0, 1, 2, 4, 8, 16, 32, 64, 128
LCD_W, LCD_H = 128, 64
package.path = here .. "/SCRIPTS/NacoSim/?.lua;" .. package.path
dofile(here .. "/test/stubs.lua").install(here)
loadScript = function(p) return loadfile(here .. "/SCRIPTS/NacoSim/" .. p:match("([^/]+)$")) end
local out = arg[1]
local K = 6
local svg
lcd = {
  clear = function() svg = {} end,
  drawLine = function(a, b, c, d, pat) svg[#svg + 1] = string.format('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="#e8e8e8" stroke-width="%d"%s/>', a * K + K / 2, b * K + K / 2, c * K + K / 2, d * K + K / 2, K - 2, pat == 1 and ' stroke-dasharray="6 18" opacity="0.55"' or "") end,
  drawText = function(x, y, t, f)
    local big = (f & 8) ~= 0
    local anchor = (f & 16) ~= 0 and "end" or ((f & 32) ~= 0 and "middle" or "start")
    svg[#svg + 1] = string.format('<text x="%d" y="%d" fill="#e8e8e8" font-family="monospace" font-size="%d" text-anchor="%s"%s>%s</text>', x * K, (y + (big and 11 or 7)) * K, big and 16 * K // 1 or 8 * K // 1, anchor, ((f & 64) ~= 0) and ' style="text-decoration:underline"' or "", t)
  end,
}
local M, C, V, St = require("model"), require("course"), require("view"), require("settings")
C.scan()
local panels = {}
for i = 2, #arg do
  local key, cp, back, dist = arg[i]:match("^([%w%-]+):(%d+):(%d+):?(%d*)$")
  dist = tonumber(dist) or 10
  C.select(key)
  local g = C.gates[tonumber(cp)]
  local s = M.new(0, 0, 3, 0)
  local cs = C.new(3)
  cs.nxt = tonumber(cp)
  M.reset(s, g[1] - g.nx * dist * (tonumber(back) == 180 and -1 or 1), g[2] - g.ny * dist * (tonumber(back) == 180 and -1 or 1), 3, (g[4] + tonumber(back)) % 360)
  s.z = g.mz
  V.draw(s, C, cs, {})
  panels[#panels + 1] = string.format('<div style="margin:8px"><div style="color:#aaa;font:12px sans-serif">%s checkpoint %s%s, %d m</div><svg width="%d" height="%d" style="background:#000;border:2px solid #444">%s</svg></div>', key, cp, back == "180" and " from the WRONG side" or " from the right side", dist, 128 * K, 64 * K, table.concat(svg))
end
local f = io.open(out, "w")
f:write('<html><body style="background:#111;display:flex;flex-wrap:wrap">' .. table.concat(panels) .. "</body></html>")
f:close()
