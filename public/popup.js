function showPopup(msg, redirect = null) {
  const popup = document.getElementById("popup");
  const text = document.getElementById("popup-text");

  if (!popup || !text) return;

  const content = popup.querySelector(".popup-content");
  if (content) {
    content.classList.remove("is-success", "is-error", "is-info");

    let tag = content.querySelector(".popup-tag");
    if (!tag) {
      tag = document.createElement("div");
      tag.className = "popup-tag";
      content.insertBefore(tag, content.firstChild);
    }

    const lowerMsg = String(msg).toLowerCase();
    if (lowerMsg.includes("otp sent") || lowerMsg.includes("successful") || lowerMsg.includes("verified") || lowerMsg.includes("saved")) {
      content.classList.add("is-success");
      tag.innerText = lowerMsg.includes("otp") ? "VERIFICATION READY" : "SUCCESS";
    } else if (lowerMsg.includes("incorrect") || lowerMsg.includes("error") || lowerMsg.includes("invalid") || lowerMsg.includes("expired") || lowerMsg.includes("not found") || lowerMsg.includes("does not match") || lowerMsg.includes("unable")) {
      content.classList.add("is-error");
      tag.innerText = "ACTION NEEDED";
    } else {
      tag.innerText = "NOTICE";
    }
  }

  text.innerText = msg;
  popup.style.display = "flex";

  if (redirect) {
    setTimeout(() => {
      window.location.href = redirect;
    }, 1500);
  }
}

function closePopup() {
  const popup = document.getElementById("popup");
  if (popup) popup.style.display = "none";
}
