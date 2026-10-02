# Connect your services and start

Everything needed to run is in this folder. Your service connections are recorded locally as you complete setup; the wizard resumes from those saved settings.

You need a free Cloudflare account, a GitHub account, Node.js 24+ and the GitHub CLI (`gh`). This computer already has the required tools. Keep **Cloudflare Workers on Free** and **GitHub paid overages disabled**. The setup creates no subscription, bought domain, paid database or AI usage.

## 1. Start the connection wizard

Open a terminal in this folder and run:

```sh
cd /home/adde/Music/willys-catalog
npm install
npm run connect
```

On another computer, use the path where you copied the project. The wizard guides you through the following connection steps. Secret inputs are hidden and saved only to an ignored local `.env` file with restricted permissions. Each valid answer is saved immediately. Completed operations are recorded in ignored `data/setup-progress.json`; it contains fingerprints, not credentials.

If a step fails or you cancel, run `npm run connect` again. It skips your completed Cloudflare setup and resumes the unfinished GitHub steps without asking for previous answers. `npm run connect:github` also resumes GitHub directly. To change a saved answer, edit the matching setting in `.env`; do not delete that file to retry a failure.

## 2. Connect Cloudflare

1. Create/sign into your account at [Cloudflare](https://dash.cloudflare.com/). Use Workers Free.
2. Find your **Account ID** on the account overview/Workers & Pages page.
3. Open [API Tokens](https://dash.cloudflare.com/profile/api-tokens), choose **Create Token → Custom token**, and grant:
   - Account → D1 → Edit
   - Account → Workers Scripts → Edit
   - Account → Account Settings → Read
4. Restrict Account Resources to the selected account. Give the token an expiry you can renew and record that date. Paste the Account ID and token into the wizard.
5. Keep store ID **2110** for the online context used by the original client, or enter your intended online fulfilment store ID. Willys online products still have a store context; 2110 is Kungsbacka Hede.

The wizard creates/reuses the `willys-catalog` D1 database, creates its tables and deploys a `willys-catalog` Worker at a free `workers.dev` address. It generates your private API access token. The API initially reports that its catalogue is not ready; that is expected before the first sync.

If your Cloudflare account has no `workers.dev` address yet, the wizard asks for a free address prefix and registers it. An existing account address is preserved.

The Cloudflare token also needs the stated Workers permission to install the service secret and daily trigger. The daily database collector only needs D1 write access; you may replace its GitHub secret with a separate account-scoped D1-only token later.

## 3. Connect GitHub

1. Enter a new or empty repository as `your-name/willys-catalog`. This answer is saved before account login or repository creation. The wizard uses the repository owner's GitHub account, switches to it if it is already signed in, or opens browser login. If you have multiple accounts, choose the intended account in that browser before authorizing GitHub CLI. The wizard verifies the resulting username before creating or changing any repository.
2. Choose **public** to use free standard Actions minutes. This publishes the project code; catalogue exports, database files and local credentials are ignored by Git. A private repository instead shares your account's included Actions quota. The wizard does not enable billing or configure larger runners.
3. The wizard pushes the code and sets the Cloudflare credentials as repository Secrets, plus the Willys store ID as a repository Variable.
4. When prompted, open [GitHub fine-grained tokens](https://github.com/settings/personal-access-tokens/new). Select the repository owner and **Only select repositories → willys-catalog**. Grant **Repository permissions → Actions → Read and write**. Metadata read access is automatic. If the repository belongs to an organization, its administrator may have to approve the token.
5. Set a future expiry, record its renewal date, create the token and paste it into the wizard. This token lets the Cloudflare daily trigger start the catalogue workflow. It is stored as a Worker secret and in your ignored `.env`; it is not committed to Git.

The wizard verifies access to the workflow, starts a connection-only job that makes no retailer requests, and deploys the final connected configuration. Check that connection job succeeds in GitHub Actions. If you stop after Cloudflare setup, run `npm run connect:github` to finish later.

For a personal repository, `GITHUB_ACCOUNT` and the owner in `GITHUB_REPOSITORY` must match. For an organization repository, set `GITHUB_ACCOUNT` in `.env` to your own member account. If `GH_TOKEN` or `GITHUB_TOKEN` in your terminal selects another account, unset that override or replace it with a token for the intended account. An account login failure preserves all completed setup steps.

## 4. First refresh and connection check

The daily trigger runs at **04:17 UTC**: 06:17 in Stockholm during summer time, 05:17 during winter time. Initial propagation of a Cloudflare cron change can take up to 15 minutes.

You can wait for the next scheduled morning, or open your repository's **Actions → Refresh Willys catalogue → Run workflow** during the **04:00–08:45 UTC** crawler window, leaving enough time for the scan to finish. Leave **connection_check** unchecked to collect products. The job refuses to crawl outside that window. It can take tens of minutes because it follows Willys' request pacing.

Then run:

```sh
npm run doctor
```

This reports the connected database, API, product count, store name, last successful sync, freshness and GitHub-token access. Also verify the daily cron appears under **Cloudflare → Worker → Settings → Trigger Events**. A connection check does not dispatch a collection job outside the permitted window.

If Cloudflare returns an authentication error, verify the account ID and token permissions. If the workflow is missing, verify the repository name and `main` branch. If the first scan is incomplete, the job reports why and keeps the previous catalogue. Do not fix that by publishing a partial scan.

## 5. Connect the meal planner

The wizard writes the two connection settings to the private file:

```text
data/mealplanner.env
```

Copy its `PRICE_API_URL` and `PRICE_API_TOKEN` values into the meal planner's **server configuration/secrets**, then deploy the planner through its normal hosting process. Select **Price database** mode and store **2110**, or the matching configured store. Keep the API token out of browser/client settings.

The Matbord project at `/home/adde/Music/mealplanner` has been updated to send mapped pack sizes and split price requests into groups of at most 400. Its existing sample ingredients still need real, verified Willys product mappings to produce a fully priced real meal plan. The new catalogue supplies products/prices; it does not guess ingredient mappings, allergen evidence or pack quantities.

## Renewing credentials or changing settings

- Renew the Cloudflare API token before expiry, update `.env`, then rerun `npm run connect:github`. The wizard updates the changed GitHub secret and preserves other completed steps.
- Renew the GitHub fine-grained token before expiry, update `GITHUB_DISPATCH_TOKEN` in `.env`, then run `npm run deploy` to replace the Worker secret.
- Change the store ID before initial import. After importing, use a separate database for a different store; publication refuses to mix stores in one catalogue.
- For private repositories, keep total Actions minutes inside your account's allowance and disable paid overages. At a maximum of 60 minutes/day, this job alone can use up to 1,860 minutes in a 31-day month. Your other jobs, retries and checks also count.
- Stay on Cloudflare Free. Free-quota errors stop work; they do not trigger an automatic upgrade. Provider limits and free-plan terms can change.

GitHub Actions run pages show collection failures. `/status` shows stale data, and `/prices/query` omits stale prices. Free hosting does not provide a strict 24-hour freshness guarantee.
