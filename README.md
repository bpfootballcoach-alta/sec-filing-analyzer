**Welcome to your Base44 project** 

**About**

View and Edit  your app on [Base44.com](http://Base44.com) 

This project contains everything you need to run your app locally.

**Edit the code in your local development environment**

Any change pushed to the repo will also be reflected in the Base44 Builder.

**Prerequisites:** 

1. Clone the repository using the project's Git URL 
2. Navigate to the project directory
3. Install dependencies: `npm install`
4. Create an `.env.local` file and set the right environment variables

```
VITE_BASE44_APP_ID=your_app_id
VITE_BASE44_APP_BASE_URL=your_backend_url

e.g.
VITE_BASE44_APP_ID=cbef744a8545c389ef439ea6
VITE_BASE44_APP_BASE_URL=https://my-to-do-list-81bfaad7.base44.app
```

Run the app: `npm run dev`

**Publish your changes**

Open [Base44.com](http://Base44.com) and click on Publish.

**Docs & Support**

Documentation: [https://docs.base44.com/Integrations/Using-GitHub](https://docs.base44.com/Integrations/Using-GitHub)

Support: [https://app.base44.com/support](https://app.base44.com/support)


**Registration scanner**

The SEC Scanner lists up to 20 recent S/F registration statements, including
S-4, F-4 and amendments. Search by ticker or CIK. Each row shows the filing date,
form and accession number and opens the primary document directly on SEC EDGAR.
Selecting a filing does not create an analysis record or invoke an AI model.

Run focused tests with `npm test` (Node.js 22.18+); run `npm run build` to build
the application. Tests use SEC response fixtures, not live company filings.

The page currently invokes Base44's hosted `fetchAndAnalyzeFiling` function.
The backend implementation tracked here is
`supabase/functions/fetch-and-analyze-filing/index.ts`, with registration lookup
in `supabase/functions/_shared/registrationFilings.ts`. Deploy that lookup logic
to the hosted Base44 function as well as any Supabase deployment before publishing
the page. The page filters out other forms defensively, but an older hosted
function can still omit S-4/F-4 or reject CIK searches. Repository changes alone
do not update the hosted function.
