import React, { useState } from 'react';

function inputComponent(props) {
    const [value, setValue] = useState()

    function handlechange(event) {
        setValue(event.target.value)
    }

    return (
        <input value={value} onchange={handlechange} />
    );
}

export default inputComponent;