import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [plan, setPlan] = useState("a");
  const [agree, setAgree] = useState(false);
  window.__formState = { name, bio, plan, agree };
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      const s = { name, bio, plan, agree };
      window.__submits = (window.__submits || []).concat([s]);
    }}>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name" />
      <textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} />
      <select id="plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
        <option value="a">甲</option><option value="b">乙</option>
      </select>
      <label><input id="agree" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />同意</label>
      <button id="go" type="submit">提交</button>
    </form>
  );
}
createRoot(document.getElementById("root")).render(<App />);
window.__formReady = true;
