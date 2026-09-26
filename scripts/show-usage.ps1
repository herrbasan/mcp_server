# Display the live usage-limits primary chips (one line per provider)
$r = Invoke-RestMethod http://localhost:3100/usage-limits.json
"updatedAt: $($r.updatedAt)  stale: [$($r.stale -join ', ')]"
foreach ($p in $r.providers.PSObject.Properties) {
    $chips = @()
    foreach ($w in ($p.Value.windows | Where-Object { $_.primary })) {
        if ($w.kind -eq 'pool') { $chips += "pool `$$($w.remaining)" }
        else { $chips += "$($w.kind) $($w.usedPct)%" }
    }
    "{0,-10} {1}" -f $p.Name, ($chips -join '  ')
}
