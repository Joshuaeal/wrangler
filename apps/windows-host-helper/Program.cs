using System.Management;

var builder = WebApplication.CreateBuilder(args);

var port = builder.Configuration["HOST_HELPER_PORT"] ?? "4100";
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

var app = builder.Build();
var seenVolumes = new Dictionary<string, VolumeRecord>(StringComparer.OrdinalIgnoreCase);

app.MapGet("/health", () => Results.Json(new { ok = true }));

app.MapGet("/volumes", () =>
{
    var now = DateTimeOffset.UtcNow;
    var volumes = ScanVolumes(now, seenVolumes)
        .OrderBy(volume => volume.name, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    return Results.Json(volumes);
});

app.Run();

static IEnumerable<VolumeRecord> ScanVolumes(
    DateTimeOffset now,
    IDictionary<string, VolumeRecord> seenVolumes)
{
    var removableDrives = DriveInfo.GetDrives()
        .Where(drive =>
            drive.DriveType == DriveType.Removable &&
            drive.IsReady &&
            !string.IsNullOrWhiteSpace(drive.Name));

    var nextMountPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var nextVolumes = new List<VolumeRecord>();

    foreach (var drive in removableDrives)
    {
        var mountPath = NormalizeMountPath(drive.RootDirectory.FullName);
        nextMountPaths.Add(mountPath);

        var metadata = ReadMetadata(drive.Name);
        seenVolumes.TryGetValue(mountPath, out var existing);

        nextVolumes.Add(new VolumeRecord(
            id: metadata.VolumeUuid ?? mountPath.TrimEnd('\\'),
            name: GetDisplayName(drive, metadata, mountPath),
            mountPath: mountPath,
            deviceIdentifier: metadata.DeviceIdentifier ?? drive.Name.TrimEnd('\\'),
            sizeBytes: metadata.SizeBytes ?? TryGetTotalSize(drive),
            removable: true,
            writable: !string.Equals(metadata.FileSystem ?? SafeGet(() => drive.DriveFormat), "CDFS", StringComparison.OrdinalIgnoreCase),
            fileSystem: metadata.FileSystem ?? SafeGet(() => drive.DriveFormat),
            insertedAt: existing?.insertedAt ?? now.ToString("O"),
            lastSeenAt: now.ToString("O")));
    }

    foreach (var staleMountPath in seenVolumes.Keys.Except(nextMountPaths, StringComparer.OrdinalIgnoreCase).ToArray())
    {
        seenVolumes.Remove(staleMountPath);
    }

    foreach (var record in nextVolumes)
    {
        seenVolumes[record.mountPath] = record;
    }

    return nextVolumes;
}

static VolumeMetadata ReadMetadata(string driveName)
{
    try
    {
        var deviceId = driveName.TrimEnd('\\');
        using var searcher = new ManagementObjectSearcher(
            "root\\CIMV2",
            $"SELECT DeviceID, VolumeSerialNumber, FileSystem, Size, DriveType, VolumeName FROM Win32_LogicalDisk WHERE DeviceID = '{deviceId}'");

        using var results = searcher.Get();
        var match = results.Cast<ManagementObject>().FirstOrDefault();

        if (match is null)
        {
            return VolumeMetadata.Empty;
        }

        return new VolumeMetadata(
            DeviceIdentifier: match["DeviceID"]?.ToString(),
            VolumeUuid: match["VolumeSerialNumber"]?.ToString(),
            FileSystem: match["FileSystem"]?.ToString(),
            SizeBytes: TryParseLong(match["Size"]),
            VolumeName: match["VolumeName"]?.ToString());
    }
    catch
    {
        return VolumeMetadata.Empty;
    }
}

static string NormalizeMountPath(string mountPath)
{
    return Path.EndsInDirectorySeparator(mountPath) ? mountPath : $"{mountPath}\\";
}

static string GetDisplayName(DriveInfo drive, VolumeMetadata metadata, string mountPath)
{
    var volumeLabel = metadata.VolumeName ?? SafeGet(() => drive.VolumeLabel);
    return string.IsNullOrWhiteSpace(volumeLabel) ? mountPath.TrimEnd('\\') : volumeLabel;
}

static long? TryGetTotalSize(DriveInfo drive)
{
    return SafeGet(() => drive.TotalSize);
}

static T? SafeGet<T>(Func<T> getter)
{
    try
    {
        return getter();
    }
    catch
    {
        return default;
    }
}

static long? TryParseLong(object? value)
{
    return value is null ? null : long.TryParse(value.ToString(), out var parsed) ? parsed : null;
}

internal sealed record VolumeMetadata(
    string? DeviceIdentifier,
    string? VolumeUuid,
    string? FileSystem,
    long? SizeBytes,
    string? VolumeName)
{
    public static VolumeMetadata Empty { get; } = new(null, null, null, null, null);
}

internal sealed record VolumeRecord(
    string id,
    string name,
    string mountPath,
    string? deviceIdentifier,
    long? sizeBytes,
    bool removable,
    bool writable,
    string? fileSystem,
    string insertedAt,
    string lastSeenAt);
