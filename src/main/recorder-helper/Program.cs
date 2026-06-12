using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NAudio.Lame;
using NAudio.Wave;

static class Arg
{
    public static string? Get(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        }
        return null;
    }

    public static bool Has(string[] args, string name)
    {
        return args.Any(a => string.Equals(a, name, StringComparison.OrdinalIgnoreCase));
    }
}

static class Device
{
    public static int FindWaveInDeviceNumber(string? query)
    {
        if (WaveIn.DeviceCount <= 0)
            return -1;

        if (string.IsNullOrWhiteSpace(query) || string.Equals(query.Trim(), "default", StringComparison.OrdinalIgnoreCase))
            return 0;

        var q = query.Trim();
        for (var i = 0; i < WaveIn.DeviceCount; i++)
        {
            var caps = WaveIn.GetCapabilities(i);
            var name = caps.ProductName ?? "";
            if (name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0)
                return i;
        }

        return 0;
    }
}

static class StdIn
{
    public static Task<string?> ReadLineAsync(CancellationToken ct)
    {
        return Task.Run(() =>
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    var line = Console.ReadLine();
                    return line;
                }
                catch
                {
                    return null;
                }
            }
            return null;
        }, ct);
    }
}

var outPath = Arg.Get(args, "--out");
if (string.IsNullOrWhiteSpace(outPath))
{
    Console.Error.WriteLine("Missing --out <path>");
    return 2;
}

var secondsStr = Arg.Get(args, "--seconds");
var micName = Arg.Get(args, "--mic");
var qualityStr = Arg.Get(args, "--quality");

var seconds = 0;
if (!string.IsNullOrWhiteSpace(secondsStr))
    int.TryParse(secondsStr, out seconds);

var quality = 4;
if (!string.IsNullOrWhiteSpace(qualityStr))
{
    if (int.TryParse(qualityStr, out var q))
        quality = Math.Clamp(q, 0, 9);
}

try
{
    var outDir = Path.GetDirectoryName(outPath);
    if (!string.IsNullOrWhiteSpace(outDir))
        Directory.CreateDirectory(outDir);
}
catch (Exception e)
{
    Console.Error.WriteLine(e.Message);
    return 3;
}

var deviceNumber = Device.FindWaveInDeviceNumber(micName);
if (deviceNumber < 0)
{
    Console.Error.WriteLine("No WaveIn devices found.");
    return 4;
}

var cts = new CancellationTokenSource();

WaveInEvent? waveIn = null;
LameMP3FileWriter? mp3 = null;

try
{
    waveIn = new WaveInEvent
    {
        DeviceNumber = deviceNumber,
        WaveFormat = new WaveFormat(44100, 16, 2),
        BufferMilliseconds = 100
    };

    mp3 = new LameMP3FileWriter(outPath, waveIn.WaveFormat, quality);

    waveIn.DataAvailable += (_, e) =>
    {
        try
        {
            mp3.Write(e.Buffer, 0, e.BytesRecorded);
            mp3.Flush();
        }
        catch
        {
        }
    };

    var stoppedTcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);

    waveIn.RecordingStopped += (_, e) =>
    {
        try
        {
            mp3.Flush();
        }
        catch
        {
        }
        stoppedTcs.TrySetResult(0);
    };

    waveIn.StartRecording();

    var stopTask = Task.Run(async () =>
    {
        try
        {
            if (seconds > 0)
            {
                await Task.Delay(TimeSpan.FromSeconds(seconds), cts.Token);
                return;
            }

            while (!cts.Token.IsCancellationRequested)
            {
                var line = await StdIn.ReadLineAsync(cts.Token);
                if (line == null)
                    break;
                if (string.Equals(line.Trim(), "q", StringComparison.OrdinalIgnoreCase))
                    break;
            }
        }
        catch
        {
        }
    }, cts.Token);

    await Task.WhenAny(stoppedTcs.Task, stopTask);

    try
    {
        waveIn.StopRecording();
    }
    catch
    {
    }

    await stoppedTcs.Task;

    return 0;
}
catch (Exception e)
{
    try
    {
        Console.Error.WriteLine(e.ToString());
    }
    catch
    {
    }
    return 5;
}
finally
{
    try { cts.Cancel(); } catch { }

    try { waveIn?.Dispose(); } catch { }
    try { mp3?.Dispose(); } catch { }
}
