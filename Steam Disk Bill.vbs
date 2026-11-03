Set shell = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
node = "D:\Programs\nodejs\node.exe"
If Not fso.FileExists(node) Then
    node = "node"
End If
shell.CurrentDirectory = folder
shell.Run """" & node & """ """ & folder & "\src\server.mjs""", 0, False
