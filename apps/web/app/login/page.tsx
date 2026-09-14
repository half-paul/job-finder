"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Compass, ArrowRight, Check } from "lucide-react";
import { api } from "../../components/client";
import { Button } from "../../components/ui/button";
export default function Login() {
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <div className="login-layout">
      <section className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <Compass size={24} />
          </span>
          JobFinder <span className="brand-ai">AI</span>
        </div>
        <div>
          <span className="eyebrow">A CAREER MOVE, WITH DIRECTION.</span>
          <h1>
            Make your next
            <br />
            chapter count.
          </h1>
          <p>
            A focused workspace for the opportunities that fit your experience,
            ambitions, and life.
          </p>
          <ul>
            {[
              "Define what matters to you",
              "Keep your opportunities in one place",
              "Build a more intentional search",
            ].map((t) => (
              <li key={t}>
                <Check size={17} />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <small>Your career information stays in your private workspace.</small>
      </section>
      <section className="login-form">
        <div>
          <span className="eyebrow">YOUR NEXT MOVE STARTS HERE</span>
          <h2>{register ? "Create your workspace" : "Welcome back"}</h2>
          <p className="muted">
            {register
              ? "A little clarity goes a long way."
              : "Sign in to pick up where you left off."}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              const data = Object.fromEntries(new FormData(e.currentTarget));
              try {
                await api(
                  `auth/${register ? "register" : "login"}`,
                  "POST",
                  data,
                );
                router.push("/");
                router.refresh();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {register && (
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={200}
                />
              </label>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                aria-label="Password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                minLength={12}
                maxLength={128}
                required
              />
              {register && <small>Use at least 12 characters.</small>}
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button disabled={busy}>
              {busy
                ? "Please wait…"
                : register
                  ? "Create workspace"
                  : "Sign in"}
              <ArrowRight size={17} />
            </Button>
          </form>
          <p className="auth-switch">
            {register ? "Already have a workspace?" : "New to JobFinder?"}{" "}
            <button
              onClick={() => {
                setRegister(!register);
                setError("");
              }}
            >
              {register ? "Sign in" : "Create an account"}
            </button>
          </p>
        </div>
      </section>
    </div>
  );
}
