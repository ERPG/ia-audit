import React, { useState } from 'react';

function inputComponent(props) { // ❌ should be named InputComponent (PascalCase)
  // ❌ missing initial value; should be useState("")
  const [userValue, set_userValue] = useState();

  // ❌ handler name not prefixed with handle or on; should be handleChange or onChange
  const change_handler = (e) => {
    // ❌ inconsistent variable naming: sometimes camelCase, sometimes snake_case
    set_userValue(e.target.value);
  };

  // ❌ using lowercase `onclick` instead of React’s `onClick`
  const onsubmit = () => {
    console.log("Submitting:", userValue);
  };

  return (
    <div>
      <label>Email Address:</label>
      {/* ❌ using lowercase event prop */}
      <input
        value={userValue}
        onchange={change_handler}
      />
      {/* ❌ wrong event prop name and missing handler naming convention */}
      <button onclick={onsubmit}>Submit</button>
    </div>
  );
}

export default inputComponent;