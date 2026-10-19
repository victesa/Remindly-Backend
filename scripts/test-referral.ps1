param(
  [string]$BaseUrl = 'http://127.0.0.1:8787'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Section {
  param([string]$Title)
  Write-Host "`n========================================================" -ForegroundColor Cyan
  Write-Host " $Title" -ForegroundColor Cyan
  Write-Host "========================================================" -ForegroundColor Cyan
}

function New-DevAuth {
  param(
    [string]$TargetUserId,
    [string]$TargetTier = 'free'
  )

  $body = @{ tier = $TargetTier; userId = $TargetUserId } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/auth/mint-token" -ContentType 'application/json' -Body $body

  return @{
    Authorization = "Bearer $($resp.token)"
  }
}

function Test-Endpoint {
  param(
    [string]$Description,
    [scriptblock]$Action,
    [int]$ExpectedStatus = 200,
    [string]$ExpectedErrorMessage = $null
  )

  Write-Host "  -> Testing: $Description..." -NoNewline
  try {
    $result = & $Action
    if ($ExpectedStatus -ge 400) {
      Write-Host " FAILED! Expected status $ExpectedStatus, but succeeded." -ForegroundColor Red
      return $false
    }
    Write-Host " PASSED [200 OK]" -ForegroundColor Green
    return $result
  } catch {
    $statusCode = 0
    $bodyText = ""
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $bodyText = $_.ErrorDetails.Message
    }
    if ($_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
      if (-not $bodyText) {
        try {
          $stream = $_.Exception.Response.GetResponseStream()
          $reader = [System.IO.StreamReader]::new($stream)
          $bodyText = $reader.ReadToEnd()
        } catch {}
      }
    }

    if ($statusCode -eq $ExpectedStatus) {
      if ($ExpectedErrorMessage -and $bodyText -notmatch [regex]::Escape($ExpectedErrorMessage)) {
        Write-Host " FAILED! Got status $statusCode, but error '$bodyText' did not match expected '$ExpectedErrorMessage'" -ForegroundColor Red
        return $false
      }
      Write-Host " PASSED [$statusCode expected]" -ForegroundColor Green
      return $true
    } else {
      Write-Host " FAILED! Status: $statusCode (expected $ExpectedStatus). Body: $bodyText" -ForegroundColor Red
      return $false
    }
  }
}

Write-Section "Remindly Referral Program Backend Test Suite"
Write-Host "Testing against $BaseUrl" -ForegroundColor Yellow

$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$referrerUid = "referrer_user_$timestamp"
$refereeUid = "referee_user_$timestamp"
$otherUserUid = "other_user_$timestamp"

Write-Host "Referrer UID:  $referrerUid"
Write-Host "Referee UID:   $refereeUid"
Write-Host "Other UID:     $otherUserUid"

$referrerHeaders = New-DevAuth -TargetUserId $referrerUid -TargetTier "free"
$refereeHeaders = New-DevAuth -TargetUserId $refereeUid -TargetTier "free"
$otherHeaders = New-DevAuth -TargetUserId $otherUserUid -TargetTier "free"

Write-Section "Step 1: Referral Code Generation"
$codeResp = Test-Endpoint -Description "GET /v1/referral/code (generate referrer code)" -Action {
  Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/referral/code" -Headers $referrerHeaders
}
$referralCode = $codeResp.referralCode
Write-Host "     Referral Code Created: $referralCode" -ForegroundColor White
Write-Host "     Invite URL:            $($codeResp.inviteUrl)" -ForegroundColor White

Write-Section "Step 1b: Invite Redirect Route (/invite?ref=...)"
try {
  $inviteReq = Invoke-WebRequest -Method Get -Uri "$BaseUrl/invite?ref=$referralCode" -MaximumRedirection 0 -ErrorAction Stop
  Write-Host "  -> Testing: GET /invite?ref=$referralCode (HTTP 302 redirect)... PASSED [302 Found]" -ForegroundColor Green
  Write-Host "     Destination: $($inviteReq.Headers.Location)" -ForegroundColor White
} catch {
  if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 302) {
    Write-Host "  -> Testing: GET /invite?ref=$referralCode (HTTP 302 redirect)... PASSED [302 Found]" -ForegroundColor Green
    Write-Host "     Destination: $($_.Exception.Response.Headers['Location'])" -ForegroundColor White
  } else {
    Write-Host "  -> Testing: GET /invite?ref=$referralCode... FAILED: $($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Section "Step 2: Self-Referral Prevention"
$selfReferral = Test-Endpoint -Description "POST /v1/referral/claim (referrer claiming their own code)" -ExpectedStatus 400 -ExpectedErrorMessage "Users cannot claim their own referral code." -Action {
  $body = @{ referralCode = $referralCode } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/referral/claim" -Headers $referrerHeaders -ContentType 'application/json' -Body $body
}

Write-Section "Step 3: Invalid Referral Code"
$invalidCode = Test-Endpoint -Description "POST /v1/referral/claim (non-existent code)" -ExpectedStatus 404 -ExpectedErrorMessage "Referral code not found." -Action {
  $body = @{ referralCode = "DOES-NOT-EXIST-999" } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/referral/claim" -Headers $refereeHeaders -ContentType 'application/json' -Body $body
}

Write-Section "Step 4: Unreferred User Claiming Reward"
$unreferredReward = Test-Endpoint -Description "GET /v1/referral/reward (before claiming any referral)" -ExpectedStatus 400 -ExpectedErrorMessage "No referral record found" -Action {
  Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/referral/reward" -Headers $otherHeaders
}

Write-Section "Step 5: Valid Referral Claim"
$validClaim = Test-Endpoint -Description "POST /v1/referral/claim (referee claiming referrer code)" -Action {
  $body = @{ referralCode = $referralCode } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/referral/claim" -Headers $refereeHeaders -ContentType 'application/json' -Body $body
}
Write-Host "     Message:      $($validClaim.message)" -ForegroundColor White
Write-Host "     Referrer UID: $($validClaim.referrerUid)" -ForegroundColor White

Write-Section "Step 6: Idempotent Referral Claim"
$idempotentClaim = Test-Endpoint -Description "POST /v1/referral/claim (referee re-claiming same code)" -Action {
  $body = @{ referralCode = $referralCode } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/referral/claim" -Headers $refereeHeaders -ContentType 'application/json' -Body $body
}

Write-Section "Step 7: Claiming Second Referral Code (Conflict)"
# Create another referral code first
$otherCodeResp = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/referral/code" -Headers $otherHeaders
$otherCode = $otherCodeResp.referralCode

$conflictingClaim = Test-Endpoint -Description "POST /v1/referral/claim (referee claiming a second different code)" -ExpectedStatus 400 -ExpectedErrorMessage "Referral has already been claimed by this user." -Action {
  $body = @{ referralCode = $otherCode } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/referral/claim" -Headers $refereeHeaders -ContentType 'application/json' -Body $body
}

Write-Section "Step 8: Check Referral Status Before Reward"
$statusBefore = Test-Endpoint -Description "GET /v1/referral/status (referee status before reward)" -Action {
  Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/referral/status" -Headers $refereeHeaders
}
Write-Host "     Referred By: $($statusBefore.referral.referredBy)" -ForegroundColor White
Write-Host "     Status:      $($statusBefore.referral.status)" -ForegroundColor White

Write-Section "Step 9: Claiming Referral Reward (Promo Code Allocation)"
$rewardResp = Test-Endpoint -Description "GET /v1/referral/reward (claim free trial promo code)" -Action {
  Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/referral/reward" -Headers $refereeHeaders
}
if ($rewardResp.promoCode) {
  Write-Host "     Assigned Promo Code: $($rewardResp.promoCode)" -ForegroundColor Green
  Write-Host "     Redemption URL:      $($rewardResp.redemptionUrl)" -ForegroundColor Green
}

Write-Section "Step 10: Duplicate Reward Claim Prevention"
$duplicateReward = Test-Endpoint -Description "GET /v1/referral/reward (claiming reward a second time)" -ExpectedStatus 400 -ExpectedErrorMessage "Referral reward has already been claimed." -Action {
  Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/referral/reward" -Headers $refereeHeaders
}

Write-Section "Step 11: Check Referral Status After Reward"
$statusAfter = Test-Endpoint -Description "GET /v1/referral/status (referee status after reward)" -Action {
  Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/referral/status" -Headers $refereeHeaders
}
Write-Host "     Status:      $($statusAfter.referral.status)" -ForegroundColor White
Write-Host "     Promo Code:  $($statusAfter.referral.promoCodeAssigned)" -ForegroundColor White
Write-Host "     Assigned At: $($statusAfter.referral.assignedAt)" -ForegroundColor White

Write-Section "All Referral Program Tests Completed Successfully!"

