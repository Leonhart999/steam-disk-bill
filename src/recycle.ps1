# Moves one folder to the Recycle Bin through the Windows shell.
# Run by windows-actions.mjs with -EncodedCommand; the target comes from STEAM_DISK_BILL_TARGET.
# FOF_ALLOWUNDO recycles; FOF_WANTNUKEWARNING makes Windows warn before any permanent deletion.
# Never add FOF_NOCONFIRMATION: that could consent to permanent deletion.
$ErrorActionPreference = 'Stop'

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
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateWindowExW")]
    private static extern IntPtr CreateWindowEx(int exStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr window);

    public static int Run(string path) {
        // The process starts hidden. Windows applies that hidden state to the first window it shows,
        // so show a throwaway owner first; the owner is topmost so the shell dialogs appear above the app.
        IntPtr owner = CreateWindowEx(0x00000008 | 0x00000080, "Static", "Steam Disk Bill", 0x80000000, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        ShowWindow(owner, 0);
        try {
            var operation = new FileOperation {
                hwnd = owner,
                function = 3,
                from = path + '\0' + '\0',
                flags = 0x0040 | 0x4000,
                title = "Steam Disk Bill"
            };
            int result = SHFileOperation(ref operation);
            if (operation.aborted || result == 1223) return 2;
            return result == 0 ? 0 : 1;
        } finally {
            if (owner != IntPtr.Zero) DestroyWindow(owner);
        }
    }
}
'@

if ($env:STEAM_DISK_BILL_VALIDATE -eq '1') { exit 0 }

$target = $env:STEAM_DISK_BILL_TARGET
if (-not [Environment]::UserInteractive -or [string]::IsNullOrWhiteSpace($target)) {
    throw 'An interactive Windows session and an explicit target are required.'
}
if (-not [System.IO.Directory]::Exists($target)) {
    throw 'The selected directory no longer exists.'
}
exit ([SteamDiskBillRecycle]::Run($target))
