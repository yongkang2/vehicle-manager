using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class WindowsLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool noBrowser = args.Length == 1 && args[0] == "--no-browser";
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(root, "runtime", "node.exe"),
                Arguments = "\"" + Path.Combine(root, "launcher.mjs") + "\"" + (noBrowser ? " --no-browser" : ""),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true
            };
            using (var process = Process.Start(start))
            {
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0)
                    throw new InvalidOperationException(error.Length == 0 ? "Startup failed. See launcher.log and startup.log for details." : error);
            }
            return 0;
        }
        catch (Exception error)
        {
            if (noBrowser) Console.Error.WriteLine(error.Message);
            else MessageBox.Show(error.Message, "Vehicle Manager", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
