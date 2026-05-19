defmodule Telemetry do
    @type t :: %__MODULE__{
        uptime: integer(),
        status: String.t(),
        flags: [integer]
    }
end

defmodule Config do
    defstruct [items: [], tag: nil]
end