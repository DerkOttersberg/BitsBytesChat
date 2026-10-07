$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=BitsBytesChat local mobile access', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $names = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $names.AddDnsName('localhost')
  foreach ($address in ($env:BITSBYTES_CERT_IPS -split ',')) { $names.AddIpAddress([System.Net.IPAddress]::Parse($address)) }
  $request.CertificateExtensions.Add($names.Build())
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
  $uses = [System.Security.Cryptography.OidCollection]::new()
  [void]$uses.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($uses, $false))
  $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddYears(2))
  try {
    [System.IO.File]::WriteAllBytes($env:BITSBYTES_CERT_PATH, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:BITSBYTES_CERT_PASSWORD))
    [System.IO.File]::WriteAllBytes($env:BITSBYTES_CERT_PATH + '.cer', $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  } finally { $certificate.Dispose() }
} finally { $rsa.Dispose() }
