-- NacoMem: how much Lua memory does this radio/model leave a script? Loads
-- NacoSim's modules one by one, reports what each costs, then fills the
-- remaining heap to find the headroom. Run it with the model you fly on: an
-- ELRS model leaves less than an empty one. Writes /LOGS/nacomem.txt.
local lines, n = {}, 0
local function add(s) n = n + 1; lines[n] = s end
local result = "running"
local started = false

local function kb() collectgarbage(); collectgarbage(); return collectgarbage("count") end

local function measure()
  local name = "?"
  if model and model.getInfo then
    local ok, info = pcall(model.getInfo)
    if ok and info and info.name then name = info.name end
  end
  local ver, radio = "?", "?"
  if getVersion then ver, radio = getVersion() end
  add("model " .. tostring(name) .. "  " .. tostring(radio) .. " " .. tostring(ver))
  local base = kb()
  add(string.format("base %.0fk", base))
  local last = base
  local mods = { "model", "course", "view", "settings" }
  local loaded = {}
  for i = 1, #mods do
    local ok, err = pcall(function()
      local chunk = assert(loadScript("/SCRIPTS/NacoSim/" .. mods[i] .. ".lua"))
      local c = kb()
      loaded[#loaded + 1] = chunk()
      local r = kb()
      add(string.format("%s +%.0fk (compile %.0f)", mods[i], r - last, c - last))
      last = r
    end)
    if not ok then
      add(mods[i] .. " FAILED: " .. tostring(err))
      result = "failed at " .. mods[i]
      break
    end
  end
  if result == "running" then
    add(string.format("modules total %.0fk", last - base))
    -- headroom: fill with 1k strings until the allocator refuses
    local blocks, count = {}, 0
    local before = kb()
    pcall(function()
      while count < 400 do
        count = count + 1
        blocks[count] = string.rep("x", 1000) .. count
      end
    end)
    local filled = count
    blocks = nil
    kb()
    add(string.format("free after modules: %s%dk", filled >= 400 and ">" or "", filled))
    result = string.format("modules %.0fk, free %s%dk", last - base, filled >= 400 and ">" or "", filled)
  end
  loaded = nil
  local f = io.open("/LOGS/nacomem.txt", "w")
  if f then
    for i = 1, n do io.write(f, lines[i] .. "\n") end
    io.close(f)
  end
end

local function run(event)
  if event == (EVT_VIRTUAL_EXIT or EVT_EXIT_BREAK) then return 1 end
  if not started then
    started = true
    lcd.clear()
    lcd.drawText(2, 2, "measuring...", 0)
    lcd.refresh()
    local ok, err = pcall(measure)
    if not ok then add("ERROR " .. tostring(err)); result = "error" end
    return 0
  end
  lcd.clear()
  for i = 1, n < 8 and n or 8 do lcd.drawText(1, (i - 1) * 8, lines[i], SMLSIZE) end
  return 0
end

return { init = function() end, run = run }
