#!/usr/bin/env python3
"""
get_perplexity_tokens.py — Grab fresh Perplexity session tokens

HOW PERPLEXITY AUTH WORKS:
  Perplexity has NO password login — only magic links sent to email.
  This script supports two methods:

METHOD 1 — Emailnator (fully automatic, recommended):
  Uses emailnator.com to auto-generate Gmail addresses + grab magic links.
  Requires: Emailnator cookies (one-time browser grab).

  Steps:
    1. Open emailnator.com in browser (logged in or fresh visit)
    2. F12 → Application → Cookies → emailnator.com
    3. Copy XSRF-TOKEN and laravel_session values
    4. Run: python3 get_perplexity_tokens.py \
               --emailnator-xsrf "YOUR_XSRF" \
               --emailnator-session "YOUR_SESSION" \
               --count 5

METHOD 2 — Manual (your own email):
  Script sends magic link to your email — you click it — token saved.

  Steps:
    1. Run: python3 get_perplexity_tokens.py --add you@gmail.com
    2. Check email, click the link
    3. Paste the full URL back into the terminal

Saves tokens to .env as PERPLEXITY_SESSION_TOKEN_1 ... _N
Pushes tokens to live proxy at http://localhost:8320 if running.
"""

import argparse, json, os, re, subprocess, sys, time, urllib.request, urllib.parse, http.cookiejar

# ─── Built-in accounts ────────────────────────────────────────────────────
# Format: (email, password_or_hint, "mailtm" | "manual")
# NOTE: dollicons.com accounts are blocked by Perplexity at login time.
#       They work as long as existing session tokens are valid.
#       For fresh tokens, use real Gmail accounts in "manual" mode.
DEFAULT_ACCOUNTS = [
    # Add real accounts here:
    # ("you@gmail.com", "", "manual"),
]

ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")
if not os.path.exists(ENV_PATH):
    ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env")
ENV_PATH = os.path.abspath(ENV_PATH)

# ─── mail.tm helpers ─────────────────────────────────────────────────────
def mailtm_token(email: str, password: str) -> str:
    body = json.dumps({"address": email, "password": password}).encode()
    req  = urllib.request.Request(
        "https://api.mail.tm/token", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())["token"]

def mailtm_messages(token: str) -> list:
    req = urllib.request.Request(
        "https://api.mail.tm/messages",
        headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read()).get("hydra:member", [])

def mailtm_message_body(token: str, mid: str) -> str:
    req = urllib.request.Request(
        f"https://api.mail.tm/messages/{mid}",
        headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.loads(r.read())
        html = d.get("html", "")
        if isinstance(html, list): html = " ".join(str(x) for x in html)
        return (d.get("text", "") or "") + " " + str(html)

def mailtm_delete(token: str, mid: str):
    req = urllib.request.Request(
        f"https://api.mail.tm/messages/{mid}",
        headers={"Authorization": f"Bearer {token}"}, method="DELETE")
    try: urllib.request.urlopen(req, timeout=10)
    except: pass

def get_magic_link_from_mailtm(mail_token: str, timeout_s: int = 90) -> str | None:
    deadline = time.time() + timeout_s
    seen = set()
    while time.time() < deadline:
        time.sleep(4)
        try:
            for msg in mailtm_messages(mail_token):
                if msg["id"] in seen: continue
                seen.add(msg["id"])
                body = mailtm_message_body(mail_token, msg["id"])
                urls = re.findall(
                    r'https://www\.perplexity\.ai/api/auth/callback/email\?[^"\'<>\s]+',
                    body)
                if urls:
                    url = urls[0].replace("&amp;", "&")
                    mailtm_delete(mail_token, msg["id"])
                    return url
        except Exception as e:
            print(f"    mail.tm poll error: {e}", flush=True)
    return None

# ─── Perplexity magic link request ────────────────────────────────────────
def request_magic_link(email: str) -> bool:
    jar    = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", "Mozilla/5.0")]
    try:
        r    = opener.open("https://www.perplexity.ai/api/auth/csrf", timeout=15)
        csrf = json.loads(r.read())["csrfToken"]
        body = json.dumps({
            "email": email, "csrfToken": csrf,
            "callbackUrl": "https://www.perplexity.ai/"
        }).encode()
        req = urllib.request.Request(
            "https://www.perplexity.ai/api/auth/signin/email",
            data=body, headers={"Content-Type": "application/json"}, method="POST")
        opener.open(req, timeout=15)
        return True
    except Exception as e:
        print(f"    Magic link request failed: {e}", flush=True)
        return False

# ─── Follow magic link → extract session cookie ───────────────────────────
def follow_magic_link(url: str) -> str | None:
    """Follow the magic link immediately using curl_cffi (must be called FAST after receiving link)."""
    try:
        import curl_cffi.requests as cf
        session = cf.Session(impersonate="chrome120")
        resp    = session.get(url, allow_redirects=True, timeout=30)
        # Check for success
        if "error" in resp.url.lower():
            print(f"    ⚠️  Redirect to error: {resp.url[:60]}", flush=True)
        for name, val in session.cookies.items():
            if "session-token" in name:
                return val
        # Try from response headers too
        for h in resp.headers.get("set-cookie", "").split(";"):
            if "session-token" in h:
                return h.split("=", 1)[-1].strip()
    except Exception as e:
        print(f"    curl_cffi error: {e}", flush=True)
    return None

# ─── Save tokens to .env ─────────────────────────────────────────────────
def save_tokens_to_env(tokens: list[str], env_path: str):
    print(f"\n📝 Saving {len(tokens)} tokens to {env_path}")

    # Read existing
    lines = []
    if os.path.exists(env_path):
        with open(env_path) as f:
            lines = f.readlines()

    # Remove old PERPLEXITY_SESSION_TOKEN_N lines (keep _0 base)
    existing_keys = set()
    new_lines = []
    for line in lines:
        k = line.split("=")[0].strip()
        if re.match(r"^PERPLEXITY_SESSION_TOKEN_\d+$", k):
            existing_keys.add(k)
            continue  # will re-add below
        new_lines.append(line)

    # Add fresh tokens
    for i, tok in enumerate(tokens, start=1):
        new_lines.append(f"PERPLEXITY_SESSION_TOKEN_{i}={tok}\n")

    with open(env_path, "w") as f:
        f.writelines(new_lines)

    print(f"✅ Saved PERPLEXITY_SESSION_TOKEN_1 through _{len(tokens)}")

# ─── Process one account ─────────────────────────────────────────────────
def process_account(email: str, password: str, mode: str) -> str | None:
    print(f"\n{'─'*50}", flush=True)
    print(f"📧 {email} [{mode}]", flush=True)

    # Get mail.tm token if needed
    mail_token = None
    if mode == "mailtm":
        try:
            mail_token = mailtm_token(email, password)
            # Clear inbox
            for msg in mailtm_messages(mail_token):
                mailtm_delete(mail_token, msg["id"])
            print("  ✅ mail.tm connected, inbox cleared", flush=True)
        except Exception as e:
            print(f"  ❌ mail.tm login failed: {e}", flush=True)
            return None

    # Send magic link
    print("  📨 Requesting magic link...", flush=True)
    if not request_magic_link(email):
        return None
    print("  ✅ Magic link sent", flush=True)

    # Get the link
    if mode == "mailtm":
        print("  ⏳ Waiting for email (up to 90s)...", flush=True)
        magic_url = get_magic_link_from_mailtm(mail_token)
    else:
        # Manual — print instructions
        magic_url = None
        print(f"\n  🔗 Check {email} inbox for a Perplexity magic link.", flush=True)
        print("  Paste the full link here:", flush=True)
        try:
            pasted = input("  > ").strip()
            if pasted.startswith("https://"):
                magic_url = pasted
        except: pass

    if not magic_url:
        print("  ❌ No magic link received", flush=True)
        return None
    print(f"  ✅ Got magic link: {magic_url[:60]}...", flush=True)

    # Follow link → get session token
    print("  🔐 Extracting session token...", flush=True)
    token = follow_magic_link(magic_url)
    if token:
        print(f"  ✅ Token: {token[:40]}... ({len(token)} chars)", flush=True)
        return token
    else:
        print("  ❌ Failed to extract session token", flush=True)
        return None

# ─── Emailnator method (fully automatic) ─────────────────────────────────
def get_tokens_via_emailnator(xsrf: str, session: str, count: int, env_path: str):
    """Auto-create N Perplexity accounts using Emailnator Gmail generator."""
    sys.path.insert(0, '/tmp/perplexity-ai-lib')
    import perplexity as perp_lib

    emailnator_cookies = {
        "XSRF-TOKEN":      xsrf,
        "laravel_session": session,
    }

    tokens = []
    print(f"\n🔮 Emailnator mode — creating {count} fresh accounts...")

    for i in range(count):
        print(f"\n  [{i+1}/{count}] Creating account...", flush=True)
        try:
            client = perp_lib.Client()
            client.create_account(emailnator_cookies)
            # Extract session token from client's session cookies
            tok = None
            for name, val in client.session.cookies.items():
                if "session-token" in name:
                    tok = val
                    break
            if tok:
                print(f"  ✅ Token: {tok[:40]}... ({len(tok)} chars)", flush=True)
                tokens.append(tok)
            else:
                print(f"  ❌ No session token in cookies after account creation", flush=True)
                print(f"     Cookies: {dict(client.session.cookies)}", flush=True)
        except Exception as e:
            print(f"  ❌ Failed: {e}", flush=True)

    if tokens:
        save_tokens_to_env(tokens, env_path)
    return tokens

# ─── Main ─────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Grab Perplexity session tokens",
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--env",   default=ENV_PATH, help=f"Path to .env (default: {ENV_PATH})")
    parser.add_argument("--add",   metavar="EMAIL",  help="Send magic link to this email (manual mode)")
    parser.add_argument("--count", type=int, default=5, help="Number of accounts to create via Emailnator")
    parser.add_argument("--emailnator-xsrf",    metavar="TOKEN",  help="Emailnator XSRF-TOKEN cookie")
    parser.add_argument("--emailnator-session", metavar="SESSION",help="Emailnator laravel_session cookie")
    args = parser.parse_args()

    print(f"\n🔮 Perplexity Token Fetcher")
    print(f"   .env: {args.env}")

    # ── Method 1: Emailnator (fully automatic) ──
    if args.emailnator_xsrf and args.emailnator_session:
        tokens = get_tokens_via_emailnator(
            args.emailnator_xsrf, args.emailnator_session, args.count, args.env)
        if tokens:
            print(f"\n🎉 {len(tokens)} tokens saved!")
        else:
            print("\n❌ No tokens obtained")
            sys.exit(1)
        return

    # ── Method 2: Manual single email ──
    if args.add:
        accounts = [(args.add, "", "manual")]
    else:
        accounts = list(DEFAULT_ACCOUNTS)

    if not accounts:
        print("""
No accounts configured. Use one of:

  # Automatic (recommended) — needs Emailnator cookies:
  python3 get_perplexity_tokens.py \\
    --emailnator-xsrf "your-xsrf-token" \\
    --emailnator-session "your-laravel-session" \\
    --count 5

  # Manual — sends magic link to your email:
  python3 get_perplexity_tokens.py --add you@gmail.com

Get Emailnator cookies:
  1. Visit emailnator.com in browser
  2. F12 → Application → Cookies → emailnator.com
  3. Copy XSRF-TOKEN and laravel_session
""")
        return

    print(f"   Mode: manual | Accounts: {len(accounts)}")

    # Step 1: connect all mail.tm inboxes and request all magic links simultaneously
    print("\n📨 Step 1: Sending all magic links simultaneously...")
    mail_tokens = {}
    for email, password, mode in accounts:
        if mode == "mailtm":
            try:
                mt = mailtm_token(email, password)
                # clear inbox first
                for msg in mailtm_messages(mt):
                    mailtm_delete(mt, msg["id"])
                mail_tokens[email] = mt
                print(f"  ✅ {email} — inbox ready")
            except Exception as e:
                print(f"  ❌ {email} — mail.tm failed: {e}")

    for email, password, mode in accounts:
        if mode == "mailtm" and email in mail_tokens:
            if request_magic_link(email):
                print(f"  📧 {email} — magic link sent")
            else:
                print(f"  ❌ {email} — failed to send")

    # Step 2: wait for all emails then follow links immediately
    print("\n⏳ Step 2: Waiting for emails and grabbing tokens FAST...")
    tokens = []
    pending = [(e, p, m) for e, p, m in accounts if m == "mailtm" and e in mail_tokens]
    manual  = [(e, p, m) for e, p, m in accounts if m == "manual"]

    deadline = time.time() + 90
    found    = set()
    while pending and time.time() < deadline:
        time.sleep(4)
        for email, password, mode in list(pending):
            if email in found:
                continue
            try:
                mt   = mail_tokens[email]
                msgs = mailtm_messages(mt)
                for msg in msgs:
                    body = mailtm_message_body(mt, msg["id"])
                    urls = re.findall(
                        r'https://www\.perplexity\.ai/api/auth/callback/email\?[^"\'<>\s]+',
                        body)
                    if urls:
                        magic_url = urls[0].replace("&amp;", "&")
                        mailtm_delete(mt, msg["id"])
                        print(f"\n  🔗 {email}: got link, following NOW...", flush=True)
                        tok = follow_magic_link(magic_url)
                        if tok:
                            print(f"  ✅ {email}: TOKEN ({len(tok)} chars)", flush=True)
                            tokens.append(tok)
                        else:
                            print(f"  ❌ {email}: no cookie in response", flush=True)
                        found.add(email)
                        break
            except Exception as e:
                pass
        elapsed = int(time.time() - deadline + 90)
        if elapsed % 16 == 0:
            print(f"  ... {elapsed}s elapsed, {len(found)}/{len(pending)} done", flush=True)

    # Manual accounts
    for email, password, mode in manual:
        tok = process_account(email, password, mode)
        if tok:
            tokens.append(tok)

    print(f"\n{'═'*50}")
    print(f"✅ Got {len(tokens)}/{len(accounts)} tokens")

    if tokens:
        save_tokens_to_env(tokens, args.env)

        # Also update live proxy if running
        for i, tok in enumerate(tokens, start=1):
            try:
                body = json.dumps({"token": tok}).encode()
                req  = urllib.request.Request(
                    "http://127.0.0.1:8320/update-token", data=body,
                    headers={"Content-Type": "application/json"}, method="POST")
                urllib.request.urlopen(req, timeout=3)
                print(f"🔄 Token {i} pushed to live proxy")
            except:
                pass  # proxy might not be running on this system

        print(f"\n🎉 Done! Tokens saved to {args.env}")
    else:
        print("\n❌ No tokens obtained")
        sys.exit(1)

if __name__ == "__main__":
    main()
