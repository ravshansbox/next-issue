Read the whole repository and look for bugs: wrong results, unhandled errors, races, security holes and documentation that contradicts the code.
Prove each finding from the code. A guess is not a finding.
Missing or brief detail in a README is not a finding. A documentation finding must quote a statement that contradicts the code.
File only a finding that a user hits in normal use. Name the steps of that use and what goes wrong for the user. Leave out a finding that needs an unusual mix of signals, timings, stops or failures.
Start the `## Problem` section with a `Severity: high`, `Severity: medium` or `Severity: low` line, and file only high findings. A finding is high when a user in normal use loses work, gets a wrong result or has a run, a push or the base branch break.
When the bug is in code that was added to fix an earlier issue, propose to remove or simplify that code instead of adding another guard, and name the earlier issue.
