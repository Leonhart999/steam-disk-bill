-- Minimal JSON encoder. Tables with the array metatable are always arrays.
-- Other tables are objects. Sequential tables (only integer keys 1..n) are arrays.

local array_mt = {}

local function is_array(value)
    if getmetatable(value) == array_mt then
        return true
    end
    local count = 0
    local max_index = 0
    for key in pairs(value) do
        if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
            return false
        end
        count = count + 1
        if key > max_index then
            max_index = key
        end
    end
    return max_index == count
end

local function escape(text)
    text = text
        :gsub("\\", "\\\\")
        :gsub('"', '\\"')
        :gsub("\b", "\\b")
        :gsub("\f", "\\f")
        :gsub("\n", "\\n")
        :gsub("\r", "\\r")
        :gsub("\t", "\\t")
    return (text:gsub("[%z\1-\31]", function(char)
        return string.format("\\u%04x", char:byte())
    end))
end

local encode

local function encode_array(value)
    local parts = {}
    for index, item in ipairs(value) do
        parts[index] = encode(item)
    end
    return "[" .. table.concat(parts, ",") .. "]"
end

local function encode_object(value)
    local keys = {}
    for key in pairs(value) do
        keys[#keys + 1] = tostring(key)
    end
    table.sort(keys)
    local parts = {}
    for _, key in ipairs(keys) do
        parts[#parts + 1] = '"' .. escape(key) .. '":' .. encode(value[key])
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

encode = function(value)
    local kind = type(value)
    if kind == "string" then
        return '"' .. escape(value) .. '"'
    end
    if kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return "null"
        end
        if value % 1 == 0 and math.abs(value) < 1e15 then
            return string.format("%.0f", value)
        end
        return string.format("%.6g", value)
    end
    if kind == "boolean" then
        return value and "true" or "false"
    end
    if kind == "nil" then
        return "null"
    end
    if kind == "table" then
        if is_array(value) then
            return encode_array(value)
        end
        return encode_object(value)
    end
    return "null"
end

local function array(items)
    return setmetatable(items or {}, array_mt)
end

return {
    encode = encode,
    array = array,
}
