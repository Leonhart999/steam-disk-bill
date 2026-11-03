param([switch]$ValidateOnly)

$ErrorActionPreference = 'Stop'

# Windows shows its own confirmation, including a warning if recycling is unavailable.
# Do not add FOF_NOCONFIRMATION: that could consent to permanent deletion.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SteamDiskBillRecycle {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileOperation {
        public IntPtr hwnd;
        public uint function;
        [MarshalAs(UnmanagedType.LPWStr)] public string from;
        [MarshalAs(UnmanagedType.LPWStr)] public string to;
        public ushort flags;
        [MarshalAs(UnmanagedType.Bool)] public bool aborted;
        public IntPtr mappings;
        [MarshalAs(UnmanagedType.LPWStr)] public string title;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHFileOperationW")]
    private static extern int SHFileOperation(ref FileOperation operation);

    public static int Run(string path) {
        var operation = new FileOperation {
            function = 3,
            from = path + '\0' + '\0',
            flags = 0x0040 | 0x4000,
            title = "Steam Disk Bill"
        };
        int result = SHFileOperation(ref operation);
        if (operation.aborted || result == 1223) return 2;
        return result == 0 ? 0 : 1;
    }
}
'@

if ($ValidateOnly) { exit 0 }

$target = $env:STEAM_DISK_BILL_TARGET
if (-not [Environment]::UserInteractive -or [string]::IsNullOrWhiteSpace($target)) {
    throw 'An interactive Windows session and an explicit target are required.'
}
if (-not [System.IO.Directory]::Exists($target)) {
    throw 'The selected directory no longer exists.'
}
$result = [SteamDiskBillRecycle]::Run($target)
exit $result
