-- Steam KeyValues (VDF) reader. Handles quoted strings and nested objects.
-- Returns the table inside the root key, e.g. the body of "AppState" or "libraryfolders".

local function parse(text)
    if not text then
        return nil, "empty vdf"
    end
    if text:sub(1, 3) == "\239\187\191" then
        text = text:sub(4)
    end

    local index = 1
    local length = #text

    local function skip()
        while index <= length do
            local char = text:sub(index, index)
            if char == " " or char == "\t" or char == "\r" or char == "\n" then
                index = index + 1
            elseif char == "/" and text:sub(index, index + 1) == "//" then
                while index <= length and text:sub(index, index) ~= "\n" do
                    index = index + 1
                end
            else
                return
            end
        end
    end

    local function parse_string()
        skip()
        if text:sub(index, index) ~= '"' then
            return nil, "expected string at " .. index
        end
        index = index + 1
        local parts = {}
        while index <= length do
            local char = text:sub(index, index)
            if char == '"' then
                index = index + 1
                return table.concat(parts)
            end
            if char == "\\" then
                local next_char = text:sub(index + 1, index + 1)
                if next_char == "" then
                    return nil, "truncated escape"
                end
                parts[#parts + 1] = next_char
                index = index + 2
            else
                parts[#parts + 1] = char
                index = index + 1
            end
        end
        return nil, "unterminated string"
    end

    local parse_value

    local function parse_object()
        index = index + 1
        local object = {}
        while true do
            skip()
            if index > length then
                return nil, "unterminated object"
            end
            if text:sub(index, index) == "}" then
                index = index + 1
                return object
            end
            local key, key_err = parse_string()
            if not key then
                return nil, key_err
            end
            local value, value_err = parse_value()
            if value == nil and value_err then
                return nil, value_err
            end
            object[key] = value
        end
    end

    parse_value = function()
        skip()
        local char = text:sub(index, index)
        if char == '"' then
            return parse_string()
        end
        if char == "{" then
            return parse_object()
        end
        return nil, "expected value at " .. index
    end

    skip()
    local _, key_err = parse_string()
    if key_err then
        return nil, key_err
    end
    return parse_value()
end

return {
    parse = parse,
}
