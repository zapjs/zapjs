'use client';
import { useActionState, useState } from 'react';
import { save } from './actions';
export default function Counter() {
  const [count, setCount] = useState(0);
  const [message, action, pending] = useActionState(save, 'Nothing saved');
  return <section><button id="counter" onClick={() => setCount(value => value + 1)}>Count: {count}</button><form action={action}><label>Name <input name="name" defaultValue="Ada" /></label><button id="save" disabled={pending}>Save name</button><output id="saved">{message}</output></form></section>;
}
