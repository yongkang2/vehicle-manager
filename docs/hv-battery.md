# Controllers and HV Battery

In a vehicle's details, **Controllers / 控制器** contains controller information.
**HV Battery / 高压电池** is a separate tab, with **Part Number / 零件号**,
**Serial Number / 序列号**, and **Part Maturity Level / 零件成熟度**.

Use **Add HV Battery**, or the edit button on an existing battery row. The three
fields are optional free text; maturity offers `Production` and `POC` suggestions
without restricting other values. Saving requires a change reason and the latest
record version, just like other business records.

The Vehicles page shows **HV Battery Maturity Level / 高压电池成熟度**. Click it
(including an empty `—`) to open that vehicle's HV Battery tab. This is calculated
from battery records, not a second editable vehicle field. Editing or clearing
the battery's maturity updates the list after saving. Removed and archived
batteries are not current. If multiple active batteries exist, all their maturity
levels are shown, with a warning in the tab rather than silently choosing one.
Removed records remain visible in the tab; **Include archived** also reveals
archived ones. Use the existing record-removal action when replacing a battery.

Existing battery records are reused, without rewriting any stored data. Storage
remains `kind: part`, `category: battery`; Part Number maps to `productPart`, Serial
Number to `serial`, and Part Maturity Level to `maturity`. This retains history,
synchronization, backups/restores and the existing part-record CSV/JSON exports.
Battery data is independent of the BMS/MSB controller and DOVE controller imports.
No schema or shared-protocol migration is needed.
