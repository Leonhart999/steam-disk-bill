-- Read-only Steam library disk report.
-- Rules mirrored in tools/preview.mjs. Keep the two in sync.

local fs = require("fs")
local json = require("json")
local vdf = require("vdf")

local REDIST_APPID = "228980"
local FULLY_INSTALLED = 4

local function array()
    return json.array({})
end

local function push(list, value)
    list[#list + 1] = value
end

local function read_file(path)
    local handle, err = io.open(path, "rb")
    if not handle then
        return nil, err or "failed to open"
    end
    local data = handle:read("*a")
    handle:close()
    return data
end

local function has_bit(flags, mask)
    return math.floor(flags / mask) % 2 == 1
end

local function dir_size(path)
    if not fs.is_directory(path) then
        return 0
    end
    local entries, err = fs.list_recursive(path)
    if not entries then
        return 0, err or "list failed"
    end
    local total = 0
    for _, entry in ipairs(entries) do
        if entry.is_file and not entry.is_symlink then
            total = total + (entry.size or 0)
        end
    end
    return total
end

local function file_size(path)
    if not fs.is_file(path) then
        return 0
    end
    local size = fs.file_size(path)
    return size or 0
end

local function sorted_ids(map)
    local ids = {}
    for id in pairs(map) do
        ids[#ids + 1] = tostring(id)
    end
    table.sort(ids, function(left, right)
        return (tonumber(left) or 0) < (tonumber(right) or 0)
    end)
    return ids
end

local function is_redist(appid, name)
    if appid == REDIST_APPID then
        return true
    end
    local lower = (name or ""):lower()
    return lower:find("redistributable", 1, true) ~= nil
        or lower:find("steamworks common", 1, true) ~= nil
end

local function list_child_sizes(root)
    local rows = array()
    local total = 0
    if not fs.is_directory(root) then
        return rows, total
    end
    local entries, err = fs.list(root)
    if not entries then
        return rows, total, err
    end
    for _, entry in ipairs(entries) do
        local bytes, size_err
        if entry.is_directory then
            bytes, size_err = dir_size(entry.path)
        elseif entry.is_file then
            bytes = file_size(entry.path)
        else
            bytes = 0
        end
        bytes = bytes or 0
        total = total + bytes
        push(rows, {
            name = entry.name,
            bytes = bytes,
            error = size_err,
        })
    end
    table.sort(rows, function(left, right)
        return (left.bytes or 0) > (right.bytes or 0)
    end)
    return rows, total
end

local function numeric_dirs(root)
    local found = {}
    if not fs.is_directory(root) then
        return found
    end
    local entries = fs.list(root)
    if not entries then
        return found
    end
    for _, entry in ipairs(entries) do
        if entry.is_directory and entry.name:match("^%d+$") then
            found[entry.name] = entry.path
        end
    end
    return found
end

local function load_libraries(steam_path, errors)
    local vdf_path = fs.join(steam_path, "steamapps", "libraryfolders.vdf")
    local text, read_err = read_file(vdf_path)
    if not text then
        push(errors, "libraryfolders.vdf: " .. tostring(read_err))
        return {
            {
                path = steam_path,
                apps = {},
            },
        }
    end
    local body, parse_err = vdf.parse(text)
    if not body then
        push(errors, "libraryfolders.vdf: " .. tostring(parse_err))
        return {
            {
                path = steam_path,
                apps = {},
            },
        }
    end
    local libraries = {}
    for key, folder in pairs(body) do
        if type(folder) == "table" and type(folder.path) == "string" then
            local apps = {}
            if type(folder.apps) == "table" then
                for appid, size in pairs(folder.apps) do
                    apps[tostring(appid)] = tonumber(size) or 0
                end
            end
            libraries[#libraries + 1] = {
                order = tonumber(key) or 0,
                path = folder.path,
                apps = apps,
            }
        end
    end
    table.sort(libraries, function(left, right)
        return left.order < right.order
    end)
    if #libraries == 0 then
        libraries[1] = { path = steam_path, apps = {} }
    end
    return libraries
end

local function manifest_ids(steamapps)
    local ids = {}
    if not fs.is_directory(steamapps) then
        return ids
    end
    local entries = fs.list(steamapps)
    if not entries then
        return ids
    end
    for _, entry in ipairs(entries) do
        local appid = entry.name:match("^appmanifest_(%d+)%.acf$")
        if appid then
            ids[appid] = fs.join(steamapps, entry.name)
        end
    end
    return ids
end

local function read_manifest(path, errors)
    local text, read_err = read_file(path)
    if not text then
        push(errors, path .. ": " .. tostring(read_err))
        return nil
    end
    local body, parse_err = vdf.parse(text)
    if not body then
        push(errors, path .. ": " .. tostring(parse_err))
        return nil
    end
    return body
end

local function missing_owners(shared, appid, known)
    local owners = {}
    if type(shared) ~= "table" then
        return owners
    end
    for _, owner in pairs(shared) do
        owner = tostring(owner)
        if owner ~= appid and owner ~= REDIST_APPID and not known[owner] then
            owners[owner] = true
        end
    end
    local list = {}
    for owner in pairs(owners) do
        list[#list + 1] = owner
    end
    table.sort(list)
    return list
end

local function scan(cold_days)
    local millennium = require("millennium")
    local steam_path = millennium.steam_path()
    local now = os.time()
    local errors = array()
    local cold_seconds = cold_days * 86400

    local libraries = load_libraries(steam_path, errors)
    local apps = {}
    local library_rows = array()
    local known = {}

    for _, library in ipairs(libraries) do
        local online = fs.is_directory(library.path)
        if online then
            local manifests = manifest_ids(fs.join(library.path, "steamapps"))
            for appid, manifest_path in pairs(manifests) do
                local body = read_manifest(manifest_path, errors)
                if body then
                    local id = tostring(body.appid or appid)
                    known[id] = true
                    apps[#apps + 1] = {
                        appid = id,
                        name = body.name or ("App " .. id),
                        library = library.path,
                        size = tonumber(body.SizeOnDisk) or library.apps[id] or 0,
                        last_played = tonumber(body.LastPlayed) or 0,
                        state_flags = tonumber(body.StateFlags) or 0,
                        installdir = body.installdir or "",
                        shared = body.SharedDepots,
                        offline = false,
                    }
                end
            end
            -- Stale libraryfolders entries whose manifest is gone are not installed.
        else
            for appid, size in pairs(library.apps) do
                known[appid] = true
                apps[#apps + 1] = {
                    appid = appid,
                    name = "App " .. appid,
                    library = library.path,
                    size = size,
                    last_played = 0,
                    state_flags = 0,
                    installdir = "",
                    shared = nil,
                    offline = true,
                }
            end
        end
    end

    local installed_bytes = 0
    local cold_bytes = 0
    local app_rows = array()

    for _, app in ipairs(apps) do
        local redist = is_redist(app.appid, app.name)
        local incomplete = false
        local install_missing = false
        local deps = array()
        local cold = false
        local never = false

        if not app.offline then
            incomplete = not has_bit(app.state_flags, FULLY_INSTALLED)
            if app.installdir ~= "" then
                local folder = fs.join(app.library, "steamapps", "common", app.installdir)
                install_missing = not fs.is_directory(folder)
            end
            local owners = missing_owners(app.shared, app.appid, known)
            for _, owner in ipairs(owners) do
                push(deps, owner)
            end
            never = app.last_played == 0
            cold = not redist and (never or (now - app.last_played) >= cold_seconds)
            installed_bytes = installed_bytes + app.size
            if cold then
                cold_bytes = cold_bytes + app.size
            end
        end

        push(app_rows, {
            appid = app.appid,
            name = app.name,
            library = app.library,
            size = app.size,
            last_played = app.last_played,
            shader = 0,
            workshop = 0,
            offline = app.offline,
            incomplete = incomplete,
            install_missing = install_missing,
            redistributable = redist,
            never_played = never,
            cold = cold,
            missing_deps = deps,
        })
    end

    local function find_app(appid, library)
        for _, row in ipairs(app_rows) do
            if row.appid == appid and row.library == library and not row.offline then
                return row
            end
        end
        return nil
    end

    local shader_total = 0
    local workshop_total = 0
    local orphan_shader = array()
    local orphan_workshop = array()
    local orphan_shader_bytes = 0
    local orphan_workshop_bytes = 0

    local function claim_caches(library_path, root, field, orphan_rows)
        local dirs = numeric_dirs(root)
        local orphan_bytes = 0
        local empty_dirs = 0
        for appid, folder in pairs(dirs) do
            local bytes, size_err = dir_size(folder)
            if size_err then
                push(errors, folder .. ": " .. tostring(size_err))
            end
            bytes = bytes or 0
            if bytes <= 0 then
                empty_dirs = empty_dirs + 1
            else
                local app = find_app(appid, library_path)
                if app then
                    app[field] = (app[field] or 0) + bytes
                else
                    -- Cache can live on a different library than the install.
                    local elsewhere = nil
                    for _, row in ipairs(app_rows) do
                        if row.appid == appid and not row.offline then
                            elsewhere = row
                            break
                        end
                    end
                    if elsewhere then
                        elsewhere[field] = (elsewhere[field] or 0) + bytes
                    else
                        push(orphan_rows, {
                            appid = appid,
                            library = library_path,
                            bytes = bytes,
                        })
                        orphan_bytes = orphan_bytes + bytes
                    end
                end
            end
        end
        return orphan_bytes, empty_dirs
    end

    local download_rows = array()
    local download_bytes = 0
    local temp_bytes = 0
    local empty_shader_dirs = 0
    local empty_workshop_dirs = 0

    for _, library in ipairs(libraries) do
        local online = fs.is_directory(library.path)
        local capacity, free, available = 0, 0, 0
        local space_err
        if online then
            local space, err = fs.space_info(library.path)
            if space then
                capacity = space.capacity or 0
                free = space.free or 0
                available = space.available or space.free or 0
            else
                space_err = err
            end
            local shader_orphans, shader_empty = claim_caches(
                library.path,
                fs.join(library.path, "steamapps", "shadercache"),
                "shader",
                orphan_shader
            )
            local workshop_orphans, workshop_empty = claim_caches(
                library.path,
                fs.join(library.path, "steamapps", "workshop", "content"),
                "workshop",
                orphan_workshop
            )
            orphan_shader_bytes = orphan_shader_bytes + shader_orphans
            orphan_workshop_bytes = orphan_workshop_bytes + workshop_orphans
            empty_shader_dirs = empty_shader_dirs + shader_empty
            empty_workshop_dirs = empty_workshop_dirs + workshop_empty
            local downloads, downloading_sum, download_err = list_child_sizes(
                fs.join(library.path, "steamapps", "downloading")
            )
            if download_err then
                push(errors, "downloading: " .. tostring(download_err))
            end
            for _, row in ipairs(downloads) do
                if (row.bytes or 0) > 0 then
                    push(download_rows, {
                        name = row.name,
                        library = library.path,
                        bytes = row.bytes,
                    })
                end
            end
            download_bytes = download_bytes + (downloading_sum or 0)
            local staging_bytes, staging_err = dir_size(fs.join(library.path, "steamapps", "temp"))
            if staging_err then
                push(errors, "temp: " .. tostring(staging_err))
            end
            temp_bytes = temp_bytes + (staging_bytes or 0)
        end

        local lib_installed = 0
        local lib_count = 0
        for _, row in ipairs(app_rows) do
            if row.library == library.path then
                lib_installed = lib_installed + row.size
                lib_count = lib_count + 1
            end
        end

        push(library_rows, {
            path = library.path,
            online = online,
            capacity = capacity,
            free = available > 0 and available or free,
            installed_bytes = lib_installed,
            app_count = lib_count,
            error = space_err,
        })
    end

    for _, row in ipairs(app_rows) do
        shader_total = shader_total + (row.shader or 0)
        workshop_total = workshop_total + (row.workshop or 0)
    end

    table.sort(orphan_shader, function(left, right)
        return left.bytes > right.bytes
    end)
    table.sort(orphan_workshop, function(left, right)
        return left.bytes > right.bytes
    end)
    table.sort(app_rows, function(left, right)
        local left_total = left.size + (left.shader or 0) + (left.workshop or 0)
        local right_total = right.size + (right.shader or 0) + (right.workshop or 0)
        return left_total > right_total
    end)

    return {
        ok = true,
        steam_path = steam_path,
        scanned_at = now,
        cold_days = cold_days,
        libraries = library_rows,
        apps = app_rows,
        orphan_shader = orphan_shader,
        orphan_workshop = orphan_workshop,
        downloads = download_rows,
        totals = {
            installed = installed_bytes,
            cold = cold_bytes,
            shader = shader_total,
            workshop = workshop_total,
            orphan_shader = orphan_shader_bytes,
            orphan_workshop = orphan_workshop_bytes,
            downloads = download_bytes,
            temp = temp_bytes,
            reclaimable = cold_bytes + orphan_shader_bytes + orphan_workshop_bytes,
            empty_shader_dirs = empty_shader_dirs,
            empty_workshop_dirs = empty_workshop_dirs,
        },
        errors = errors,
    }
end

local function scan_disk(cold_days)
    cold_days = tonumber(cold_days) or 730
    if cold_days < 1 then
        cold_days = 1
    end
    if cold_days > 3650 then
        cold_days = 3650
    end
    local ok, report = pcall(scan, cold_days)
    if not ok then
        return json.encode({
            ok = false,
            error = tostring(report),
        })
    end
    return json.encode(report)
end

return {
    scan_disk = scan_disk,
}
