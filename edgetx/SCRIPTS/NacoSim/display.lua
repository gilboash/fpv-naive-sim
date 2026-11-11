-- Screen profile: everything that differs between radios lives here. The rest
-- of NacoSim asks this module for sizes, fonts and colours and never assumes
-- a 128x64 monochrome LCD. Loaded once at start; reads LCD_W / LCD_H.
local D = {}
local floor = math.floor

D.W, D.H = LCD_W or 128, LCD_H or 64
-- colour API present (EdgeTX colour radios): lcd.setColor and lcd.RGB exist
D.colour = (lcd ~= nil and lcd.setColor ~= nil and lcd.RGB ~= nil) and true or false

if D.colour then
  D.small, D.mid = SMLSIZE or 0, MIDSIZE or 0
  D.lh = 16                      -- small-text line height, px
  D.cw = 8                       -- small-text char width, px (estimate)
  D.grid = 3                     -- grid half-extent in cells (7x7 lines)
  D.gatesAhead = 3               -- next gate + this many after it, drawn
  D.thick = true                 -- gates drawn two px wide
else
  D.small, D.mid = SMLSIZE or 0, MIDSIZE or 0
  D.lh = 8
  D.cw = 5
  D.grid = 1                     -- 3 + 3 lines: every line costs instructions
  D.gatesAhead = 1
  D.thick = false
end

-- horizontal focal length: about 116 degrees across whatever the width
D.F = D.W * 0.31
D.hh = D.lh + 1                  -- y of the rule under a screen title
D.rowH = D.lh + 2                -- menu row pitch
D.rows = floor((D.H - (D.hh + 3)) / D.rowH)
if D.rows < 3 then D.rows = 3 end

local RGB = {
  bg = { 8, 14, 28 }, grid = { 40, 120, 70 }, horizon = { 210, 215, 225 },
  gate = { 90, 190, 255 }, next = { 255, 205, 40 }, hud = { 235, 235, 235 },
  msg = { 255, 90, 80 },
}
local cache, last = {}, nil

-- flags for a drawing call in colour role `role` ("" on monochrome)
local function colourFlag(role)
  if not D.colour then return 0 end
  if role ~= last then
    local c = cache[role]
    if not c then
      local t = RGB[role] or RGB.hud
      c = lcd.RGB(t[1], t[2], t[3])
      cache[role] = c
    end
    lcd.setColor(CUSTOM_COLOR, c)
    last = role
  end
  return CUSTOM_COLOR
end

function D.clear()
  if D.colour then
    last = nil
    lcd.setColor(CUSTOM_COLOR, lcd.RGB(RGB.bg[1], RGB.bg[2], RGB.bg[3]))
    lcd.clear(CUSTOM_COLOR)
  else
    lcd.clear()
  end
end

function D.line(x1, y1, x2, y2, pat, role)
  if D.colour then
    lcd.drawLine(x1, y1, x2, y2, pat or SOLID, colourFlag(role))
  else
    lcd.drawLine(x1, y1, x2, y2, pat or SOLID, FORCE)
  end
end

-- text; flags are the usual alignment/size flags (D.small, RIGHT, CENTER...)
function D.text(x, y, str, flags, role)
  lcd.drawText(x, y, str, (flags or 0) + colourFlag(role or "hud"))
end

return D
