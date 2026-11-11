-- Shared stubs for the radio's file system: dir() and the maps folders. The
-- maps folder is edgetx/SCRIPTS/NacoSim/maps plus, when present on this
-- machine, the git-ignored edgetx/maps-local, exactly what the zip carries.
local M = {}

local function exists(path)
  local f = io.open(path, "r")
  if f then f:close() return true end
  return false
end

-- listing of a real directory (desktop only: uses ls)
local function ls(path)
  local names = {}
  local p = io.popen('ls "' .. path .. '" 2>/dev/null')
  if p then
    for name in p:lines() do names[#names + 1] = name end
    p:close()
  end
  return names
end

-- here: the edgetx directory. Call after any other io.open wrapper is set up.
function M.install(here)
  -- EdgeTX's io takes the file as the first argument; desktop Lua uses methods
  io.write = function(f, ...) return f:write(...) end
  io.read = function(f, n) return f:read(n) end
  io.close = function(f) return f:close() end
  local dirs = { here .. "/SCRIPTS/NacoSim/maps", here .. "/maps-local" }
  local realOpen = io.open
  io.open = function(p, m)
    local name = p:match("^/SCRIPTS/NacoSim/maps/([^/]+)$")
    if name then
      for _, d in ipairs(dirs) do
        local real = d .. "/" .. name
        if (m or "r") == "r" and exists(real) then return realOpen(real, m) end
      end
      return nil
    end
    return realOpen(p, m)
  end
  dir = function(path)
    assert(path == "/SCRIPTS/NacoSim/maps", "unexpected dir " .. tostring(path))
    local all = {}
    for _, d in ipairs(dirs) do for _, n in ipairs(ls(d)) do all[#all + 1] = n end end
    local i = 0
    return function() i = i + 1; return all[i] end
  end
end

return M
