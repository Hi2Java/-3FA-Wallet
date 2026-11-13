async function requireAuth(options = {}) {
  const { onSuccess } = options;

  try {
    const res = await fetch("/me", {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });

    if (!res.ok) {
      window.location.href = "/login.html";
      return null;
    }

    const user = await res.json();
    if (typeof onSuccess === "function") {
      onSuccess(user);
    }
    return user;
  } catch {
    window.location.href = "/login.html";
    return null;
  }
}
