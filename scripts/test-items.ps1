param(
  [string]$BaseUrl = 'http://127.0.0.1:3000',
  [string]$UserId = 'qa_premium_items',
  [string]$Tier = 'premium'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-DevAuth {
  param(
    [string]$TargetUserId,
    [string]$TargetTier = 'premium'
  )

  $body = @{ tier = $TargetTier; userId = $TargetUserId } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/auth/mint-token" -ContentType 'application/json' -Body $body

  return @{
    Authorization = "Bearer $($resp.token)"
    'X-User-Tier' = $TargetTier
  }
}

function Invoke-ExtractCapture {
  param(
    [hashtable]$Headers,
    [string]$Text
  )

  $body = @{
    text = $Text
    currentDate = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json

  return Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/extract-data" -Headers $Headers -ContentType 'application/json' -Body $body
}

function Get-StoredItems {
  param([hashtable]$Headers)
  return Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/items" -Headers $Headers
}

function Update-StoredItem {
  param(
    [hashtable]$Headers,
    [string]$ItemId,
    [hashtable]$Patch
  )

  $body = $Patch | ConvertTo-Json
  return Invoke-RestMethod -Method Patch -Uri "$BaseUrl/v1/items/$ItemId" -Headers $Headers -ContentType 'application/json' -Body $body
}

function Remove-StoredItem {
  param(
    [hashtable]$Headers,
    [string]$ItemId
  )

  return Invoke-RestMethod -Method Delete -Uri "$BaseUrl/v1/items/$ItemId" -Headers $Headers
}

function Test-ItemRoundTrip {
  $headers = New-DevAuth -TargetUserId $UserId -TargetTier $Tier

  Write-Host "[1/5] Creating premium capture..."
  $extract = Invoke-ExtractCapture -Headers $headers -Text 'Interview with Acme next Tuesday at 10am. Bring CV and references.'

  Write-Host "[2/5] Reading items..."
  $itemsBefore = Get-StoredItems -Headers $headers
  if ($itemsBefore.count -lt 1) {
    throw "Expected at least 1 item for user $UserId, got 0"
  }

  $itemId = $itemsBefore.items[0].id
  Write-Host "[3/5] Updating item $itemId (DONE + title/category)..."
  $updated = Update-StoredItem -Headers $headers -ItemId $itemId -Patch @{
    state = 'DONE'
    title = 'Updated Job Interview'
    category = 'Jobs'
    summary = 'Updated notes from test script'
  }

  Write-Host "[4/5] Verifying update..."
  $itemsAfterUpdate = Get-StoredItems -Headers $headers
  $updatedFromList = $itemsAfterUpdate.items | Where-Object { $_.id -eq $itemId } | Select-Object -First 1
  if (-not $updatedFromList) {
    throw "Updated item $itemId not found in list"
  }

  Write-Host "[5/5] Deleting item $itemId..."
  $null = Remove-StoredItem -Headers $headers -ItemId $itemId

  $itemsAfterDelete = Get-StoredItems -Headers $headers
  $stillExists = $itemsAfterDelete.items | Where-Object { $_.id -eq $itemId } | Select-Object -First 1
  if ($stillExists) {
    throw "Item $itemId still exists after delete"
  }

  if (-not $updated.source) {
    throw "Expected persisted source metadata on updated item"
  }
  if (-not $updated.source.sourceUrl) {
    throw "Expected source.sourceUrl to be persisted"
  }

  [PSCustomObject]@{
    userId = $UserId
    extractSuccess = $extract.success
    persistedToFirebase = $extract.metadata.persistedToFirebase
    updatedItemId = $updated.id
    updatedState = $updated.state
    updatedCategory = $updated.data.category
    updatedOrganization = $updated.data.organization
    sourceUrl = $updated.source.sourceUrl
    sourceDomain = $updated.source.sourceDomain
    deleted = $true
  }
}

Test-ItemRoundTrip | ConvertTo-Json -Depth 8
