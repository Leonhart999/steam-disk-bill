local logger = require("logger")
local millennium = require("millennium")
local scan = require("scan")

-- Starlight exports global functions marked with @ffi to the frontend as backend.<name>().

---@ffi
--- Scan local Steam libraries. Returns a JSON report. Read-only.
---@param cold_days number Days since last play before an install counts as cold.
---@return string
function scan_disk(cold_days)
    logger:info("Disk bill scan requested")
    return scan.scan_disk(cold_days)
end

local function on_load()
    logger:info("Disk Bill loaded (" .. millennium.version() .. ")")
    millennium.ready()
end

local function on_unload()
    logger:info("Disk Bill unloaded")
end

local function on_frontend_loaded()
    logger:info("Disk Bill frontend ready")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
