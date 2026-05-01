# User Manual

So I see you want to know more. During the course of the manual we'll attempt to explain what the schema actually is. And more interestingly how to use schema-pop to build a simple esp32 firmware.

## What is a schema
### Software analogy

Imagine your software as if it were a company. You have your own workers (modules) - each doing it's job, they all know perfectly well how to work with each other. They've been trained (written) to do exactly that. You rent a small bar. You hire John and Paul to tend the bar.  Everything set up for success.  You're ready to serve your first

### Clients

Now while you have perfect control over your own workers, you'll soon find out that each customer is different. First will order a single beer, second might want 3 cases, yet another one will blubber  some random numbers indistinctly. So as any practical man would do - you put up a poster explaining your rules. 
 - One beer -> show one finger, 
 - One case -> show fist with one hand and one finger with the other
 - One shot -> tap a bar and show a finger
 
 Congratulations! You have created your first
### External Contract 

That's exactly what schema is, it's a set of rules explaining exactly how to get what you need. It is your* contract, works perfectly fine in your situation, but there's no chance in hell such a system would work in a retail store.
It is public - everyone can read and understand your poster.
It is complete - well assuming you're only selling a single malt.

So everything is going smoothly until John (who was mainly washing dishes) decides to quit. No big deal, you hire Josh. Next day you come into the bar and it looks like a disaster, broken glasses everywhere. Josh and Paul yelling at each other. Customers angry - a total mess.

You start talking and soon you find out that while John was keeping clean glasses on his right side, Josh did it other way around. Well no big fuss - you just make new poster 
- <- dirty dishes here 
- clean dishes here ->
Everything works again, and now you  have your first

### Internal contract

It simply explains how each of the workers (modules) interact with each other. You no longer hire John, Josh or Paul, you hire a dishwasher. Orders go smoothly, all dishes are clean and shiny. You're a happy pal now, but something still bothers you. 

Could we have avoided all those problems completely? All it took was just two posters explaining the rules! 

Exactly. And that's why schema is so important for development nowadays. Now you might think "yeah right no software is so simple", and you're absolutely right. Some smart people noticed that too we have evolved through stages. If you really think about that even the Sumerians had their contracts written on clay tablets. But we're long past that so:

### How do you define a schema

We 💓 arktype so we use that, but you can 
- use any modern library supporting [Standard schema](https://standardschema.dev/) (zod, valibot ...), 
- import openApi (swagger) schema. 
- AI can generate one for you.
- or you just engrave it on clay tablet*

Let's assume you have an esp32 lying around and you would like something to monitor your gpio's.  

```typescript
const PinStatus = type({
    pin_number: "number",
    state: "boolean",
    mode: "string"
});
```

That's just a very simple schema, slightly useful, but not very. Like we only have single pin, and you can just enter any text as mode, Let's improve that slightly

```typescript
const $ = scope({
    PinStatus: {
        pin_number: "number",
        state: "boolean",
        mode: "'input' | 'output'"
    }
    DeviceStatus: {
        pins: "Pinstatus[]"
    }
});
```

So now we have a DeviceStatus, that can list statuses of mulitple pins. 
Notice the mode -> this is called an Union Type. Those are very useful, you'll see more why during this tutorial. 

Now a keen observer will say whoa, why do you have state on your outputs? And a boolean is not enough for showing voltage levels...

```typescript
const $ = scope({
    BasePin: {
        pin_number: "number",
    },
    InputPin: {
        "...": "BasePin",
        mode: "'input'",
        state: "number"
    },
    OutputPin: {
        "...": "BasePin",
        mode: "'output'"
    }
    PinStatus: "InputPin | OutputPin",
    DeviceStatus: {
        pins: "Pinstatus[]"
    }
});
```

Ok so now let's analyse that. We have DeviceStatus, it can list multiple pin statuses. PinStatus can be either an InputPin or an OutputPin. Now you'll notice the weird "...":"BasePin" syntax what it does is it simply tells ArkType, here take all the properties of the "BasePin" and put those here too. It's simply a shortcut, if we add something new to BasePin, both InputPin and OutputPin will have that property too.

Now what's the deal with the mode? There are some core typescript concepts here to understand
- [Symbols](https://www.typescriptlang.org/docs/handbook/symbols.html) in our code "'input'" "'output'" you might have noticed the double quotes, they indicate that the text inside is a symbol and not a type like "string" or "number", you can name those any way you want.
- [Discriminated union](https://www.typescriptlang.org/docs/handbook/unions-and-intersections.html) In our code we define it as PinStatus: "InputPin | OutputPin", the important part here is the discriminator. Basically typescript must be able to discern the types not based on their name (InputPin, OutputPin), but rather based on the data they carry.  So here mode is our discriminator, typescript can simply look at this and without any doubt tell mode is 'output' therefore this is without any doubt an OutputPin.

Now that's properly explained, we could say that we have pretty much a workable contract, let's do one more quick evolution so I can better explain the issues:

```typescript
const $ = scope({
	BasePin: {
	pin_number: "number",
},
InputPin: {
	"...": "BasePin",
	mode: "'input'",
	state: "number"
},
OutputPin: {
	"...": "BasePin",
	mode: "'output'"
}
PinStatus: "InputPin | OutputPin",
DeviceStatus: {
	pins: "PinStatus[]"
}
SetPinMode: {
	pin: "number"
	mode: "'input' | 'output'"
},
SetPinState: {
	pin: "number",
	state: "number"
}
WsMessage: "DeviceStatus | SetPinMode | SetPinState"
});
```

Now we're talking! We have successfully defined our own communication protocol, simple yet good enough in some cases. 

Now anyone with knowledge of how embedded system works will say it's useless as you can set port number to any value, same with state, dynamic lists means issues with memory management, all kinds of headaches. 

Another keen observer might point out that we already can limit them, the schema supports setting limits for numeric values, array length or even limit the length of the string.

Seems like a good point so here we go:

```typescript
const $ = scope({
    BasePin: {
        pin_number: "0 >= number <= 21",
    },
    InputPin: {
        "...": "BasePin",
        mode: "'input'",
        state: "0 <= number <= 4294967295"
    },
    OutputPin: {
        "...": "BasePin",
        mode: "'output'"
    }
    PinStatus: "InputPin | OutputPin",
    DeviceStatus: {
        pins: "PinStatus[]<=13>"
    }
    SetPinMode: {
        pin: "0 >= number <= 21"
        mode: "'input' | 'output'"
    },
    SetPinState: {
        pin: "0 >= number <= 21",
        state: "0 <= number <= 4294967295"
    }
    WsMessage: "DeviceStatus | SetPinMode | SetPinState"
});
```

Let's see esp32c3 has 13 pins numbered between 0 and 21, it allows u32 value for state so it's a number between 0 and 4294967295.
Nice, we could still define our pins better but it's fine for this example. If we validate our inputs against this schema the values will be fine. Tradititionally that would go to your systems programmers, they would create their magic types somehow. So ...

## How is schema-pop schema different?

First and foremost schema-pop no longer treats binary types as 'just a number between zero and', here's how this schema looks with schema-pop extenstion enabled:


```typescript
import {scope, binary} from "schema-pop"
const $ = scope({
	...binary.import(),
    BasePin: {
        pin_number: "0 >= number <= 21",
    },
    InputPin: {
        "...": "BasePin",
        mode: "'input'",
        state: "u32"
    },
    OutputPin: {
        "...": "BasePin",
        mode: "'output'"
    }
    PinStatus: "InputPin | OutputPin",
    DeviceStatus: {
        pins: "PinStatus[]<=13>"
    }
    SetPinMode: {
        pin: "0 >= number <= 21"
        mode: "'input' | 'output'"
    },
    SetPinState: {
        pin: "0 >= number <= 21",
        state: "u32"
    }
    WsMessage: "DeviceStatus | SetPinMode | SetPinState"
});
```

If you try to export that schema, you will actually get exactly the same output as the schema above. The secret is in how schema-pop uses type metadata, here's how u32 is defined

```typescript
u32: "Binary<0 <= number <= 4294967295, 4, 4, 'u32'>",
```

So basically schema-pop tells arktype, this is a number, it can has those values, it will take up exactly 4 bytes of memory.

Now arktype will do nothing with this information itself, but that's what schema-pop is for. Our analyzer will gather all the information about the binary representation, it will calculate the most optimal in memory layout and will generate exact source code in virtually any language to use and interact with the types. 

Let's actually go ahead and we'll create your first

## schema-pop monorepo

Go to your favorite shell and run:

```
bun create schema-pop
```

Now you just need to answer few questions

TO BE CONTINUED...