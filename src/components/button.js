function button(props) {
    var Text = 'Click me!'
    
    const HANDLE_click = function(e) {
        if(props.onClick != null)
            props.onClick()
        return;
    }
    
    return (
        <button style={{ 'background-color': 'blue' }} onclick={HANDLE_click}>
            {Text}
        </button>
    );
};

export default button