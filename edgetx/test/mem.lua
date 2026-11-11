-- Runs the NacoMem probe against a stub radio, with the radio's missing
-- libraries hidden, and checks it loads every module, reports, and writes its
-- log. Run: lua edgetx/test/mem.lua
local here = arg[0]:match("^(.*)/test/mem.lua$") or "edgetx"
SOLID, DOTTED, FORCE, SMLSIZE, MIDSIZE, RIGHT, CENTER, INVERS, BLINK = 0, 1, 2, 4, 8, 16, 32, 64, 128
EVT_VIRTUAL_EXIT = 1
LCD_W, LCD_H = 128, 64
local texts = {}
lcd = { clear = function() texts = {} end, drawLine = function() end, refresh = function() end,
  drawText = function(x, y, t) texts[#texts + 1] = t end }
getVersion = function() return "2.10.0", "t14" end
model = { getInfo = function() return { name = "ELRS" } end }
loadScript = function(p) return loadfile(here .. "/SCRIPTS/NacoSim/" .. p:match("([^/]+)$")) end
local realOpen = io.open
local logPath = os.tmpname()
local _remove = os.remove
io.open = function(p, m) if p == "/LOGS/nacomem.txt" then p = logPath end return realOpen(p, m) end
io.write = function(f, ...) return f:write(...) end
io.close = function(f) return f:close() end
table, os = nil, nil   -- the radio has neither
LOADED_OK = true
local tool = dofile(here .. "/SCRIPTS/TOOLS/NacoMem.lua")
tool.init()
tool.run(0)            -- measures
tool.run(0)            -- shows the result
local f = assert(realOpen(logPath)); local txt = f:read("a"); f:close()
_remove(logPath)
print(txt)
assert(txt:find("model ELRS"), "model name missing")
for _, m in ipairs({ "model", "course", "view", "settings" }) do assert(txt:find(m .. " %+"), m .. " not reported") end
assert(txt:find("free after modules"), "headroom missing")
assert(not txt:find("FAILED") and not txt:find("ERROR"), "probe reported a failure")
assert(#texts >= 5, "nothing shown")
print("mem probe ok")
