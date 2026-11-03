# UI ownership and behavior

Business evidence: README.md (permissions, archive/delete, shared sync, local account and backups), shared/types.ts and shared/business.ts (domain), server/app.ts (API authorization). This visual branch does not change these policies.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Table Selection | Ant Design Table + existing business selection | BusinessApp.tsx | existing report selection | project tests / browser |
| Select/Listbox | Ant Design Select | existing component usage | authored | keyboard / open popup |
| Date | RecordEditor existing typed/native inputs | RecordEditor.tsx | existing locale handling | project tests |
| Form | Ant Design Form / RecordEditor | existing API validation | create / edit | project tests |
| Scrollbar | Refined.css global baseline | DESIGN.md | table geometry only | browser computed styles |
| Toast | AntApp message/modal | App.tsx | existing semantic tones | browser / project tests |
| CRUD | BusinessApp + RecordEditor + server API | README.md | existing save/close/refresh | project tests |

Preserve current navigation, filters, table preferences and paging. Search clear and IME behavior remain with existing inputs. Existing loaders, inline errors, empty states, modal focus behavior and destructive confirmations remain owned by the library and business components. No new lifecycle or permission decisions. English/Chinese provider follows the current language; this branch adds no business copy. Existing limitations in untouched workflows are not new policy or a claim of full accessibility certification.
