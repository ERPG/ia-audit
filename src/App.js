import { useEffect, useState } from 'react';

function App() {
    const [count, setCount] = useState(0);

    useEffect(() => {
        console.log('Bucle infinito ejecutándose...');
        setCount((prev) => prev + 1); // Esto causa un render infinito
    });

    return <h1>Count: {count}</h1>;
}

export default App;
