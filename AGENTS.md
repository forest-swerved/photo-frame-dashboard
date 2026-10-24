# Family Frame (photo-frame-dashboard)
Web dashboard in `dashboard/` (Vite), iOS app in `ios/`, Supabase in `supabase/`. Hardware/device operations need their own explicit task.

## Commands
| need | run |
|---|---|
| web tests | `npm --prefix dashboard test` |
| web build | `npm --prefix dashboard run build` |

## Ship
Use the deployment target the request names. `dashboard/vercel.json` defines the Vercel API/functions/cron deployment; `npm --prefix dashboard run deploy:static-cloudflare` deploys static assets only. One is not verification of the other. No checked-in app CI.
