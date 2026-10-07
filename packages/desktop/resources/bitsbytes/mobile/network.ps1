$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)
$interfaces = @(Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue)
$adapters = @(Get-NetAdapter | ForEach-Object {
  $adapter = $_
  $route = $routes | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex } | Sort-Object RouteMetric | Select-Object -First 1
  $ipInterface = $interfaces | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex } | Select-Object -First 1
  [pscustomobject]@{
    name = $adapter.Name
    hardware = [bool]$adapter.HardwareInterface
    up = [string]$adapter.Status -eq 'Up'
    metric = if ($route) { [int]$route.RouteMetric + [int]$ipInterface.InterfaceMetric } else { $null }
  }
})
ConvertTo-Json -InputObject $adapters -Compress
